/**
 * The provider-facing turn types: the catalog model, routing options and
 * selection, the turn parameters and result, the agent-loop message shape and
 * tool definitions. Plain data; no behavior.
 */
import type { CostBasis } from "../contract/mod.ts";
import type { HttpTransport } from "./http.ts";

export type ModelAccessModality =
  | "local"
  | "frontier-hosted"
  | "aggregator-hosted"
  | "subscription-oauth"
  | "custom-hosted";

export interface WorkbenchModel {
  slug: string;
  displayName: string;
  provider: string;
  api: string;
  baseUrl: string;
  tier: 0 | 1 | 2;
  costInput: number;
  costOutput: number;
  /**
   * Catalog prompt-cache prices per million tokens, when the row declares
   * them. Absent means unpriced (the schema default is zero), and metering
   * then charges cache traffic at `costInput` so cost is never understated.
   */
  costCacheRead?: number;
  costCacheWrite?: number;
  capabilities: string[];
  /**
   * Catalog limits, when the registry row declares them. `contextWindow` is
   * the total token window (input + output); `maxOutputTokens` the per-response
   * output cap. Absent/zero rows load as undefined — consumers must treat the
   * limits as unknown, not unlimited.
   */
  contextWindow?: number;
  maxOutputTokens?: number;
  /** Inferred provider access category (local loopback, direct vendor, aggregator, subscription, or custom). */
  modality?: ModelAccessModality;

  // Optional execution & architecture profile (primarily for local / open-weights):
  architecture?: "dense" | "moe";
  totalParamsB?: number;
  activeParamsB?: number;
  recommendedQuant?: string;
  residentRamGiB?: number;
  reasoningEffortControl?: boolean;
}

export interface WorkbenchRoutingOptions {
  modelId?: string;
  tier?: 0 | 1 | 2;
  hint?: "code" | "chat" | "reasoning";
  fast?: boolean;
}

export interface WorkbenchSelection {
  selected: WorkbenchModel;
  considered: string[];
  reason: string;
}

export type { CostBasis };

/**
 * Who answered a provider call, when the provider names it: the upstream that
 * served it, and the provider's own generation id for it. Both are
 * provider-supplied text, sanitized and bounded before they leave the adapter.
 */
export interface ProviderUpstreamEvidence {
  /** The upstream that served the call, as the provider named it. */
  upstreamProvider?: string;
  /** The provider's generation id for this call. */
  providerGenerationId?: string;
}

export interface WorkbenchTurnResult {
  text: string;
  model: WorkbenchModel;
  selection: WorkbenchSelection;
  toolCalls?: WorkbenchToolCall[];
  /**
   * What the next request of this tool turn must send back verbatim in place
   * of this reply, when the provider requires it (Anthropic thinking blocks).
   * Absent when the reply carries nothing to replay.
   */
  replay?: ProviderReplay;
  /**
   * The operator-facing narration a tool-calling reply wrote before its tool
   * calls, in order, when the provider returns it apart from the streamed
   * text: on Anthropic models with progress updates, the reply's text and
   * its progress-update thinking text. Display only: never sent back.
   */
  progressText?: string;
  usage: {
    input: number;
    output: number;
    /**
     * `basis` says where `total` came from: the amount the provider reported
     * billing for this call, or the catalog rates times the metered tokens.
     * Absent means a catalog estimate; only adapters that read a billed cost
     * set it.
     */
    cost: { total: number; basis?: CostBasis };
    cacheRead: number;
    cacheWrite: number;
    /**
     * Provider-reported reasoning/thinking tokens, or a character estimate
     * when an interrupted streaming adapter received plaintext reasoning
     * without a covering usage total. These are drawn from the model's output
     * budget but are not part of `output`, which can include generated text
     * withheld from display. Used by length-stop classification and receipts;
     * each adapter computes its own cost without callers adding this field
     * again. Unobserved reasoning => 0.
     */
    reasoning?: number;
  };
  stopReason: "stop" | "length" | "tool_use" | "error" | "aborted";
  timings: WorkbenchCallTimings;
  /** Present only when cancellation won before any provider request began. */
  requestDispatched?: false;
  /**
   * Who answered, when the provider named it: the upstream that served the
   * call and the provider's generation id for it. Absent for a provider that
   * reports neither, for an adapter that does not read them, and for a call
   * that failed before a response arrived.
   */
  upstream?: ProviderUpstreamEvidence;
  /**
   * Safe metadata for textual tool-call markup left in the text that ran no
   * tool: function elements in complete blocks recovery did not run, plus
   * repeated unmatched wrapper openings.
   */
  unparsedToolCallMarkup?: {
    /**
     * Bounded count of unrun function elements in complete `<tool_call>`
     * blocks (each counted once, toward its innermost wrapper) plus unmatched
     * exact `<tool_call>` openings (counted only when there are two or more).
     */
    count: number;
    countIsLowerBound: boolean;
  };
}

/**
 * A provider reply kept for verbatim replay within one tool turn. Opaque to
 * the engine, which only carries it on the assistant message the reply
 * became; the adapter that produced it decides whether it may still be sent.
 * `content` is model-provided data (Anthropic thinking signatures among it):
 * it is never logged, journaled, or shown.
 */
export interface ProviderReplay {
  /** The wire API that produced it; another adapter ignores it. */
  api: string;
  /** Digest of the request that produced the reply, up to the reply. */
  prefixDigest: string;
  /** The reply's content blocks, in order, as the provider returned them. */
  content: readonly unknown[];
}

export interface WorkbenchToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface WorkbenchToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * One turn in a multi-step agent-loop transcript. The system prompt is NOT
 * carried here — it stays in WorkbenchTurnParams.systemPrompt and each adapter
 * places it where its wire format wants it (a `system` message for OpenAI, the
 * top-level `system` field for Anthropic). `messages` is the user/assistant/tool
 * history that grows as the loop iterates, so the model sees its own prior
 * tool-call intentions and the matching results — not a flattened summary string
 * that drops its reasoning trail and invites confabulation.
 *
 * `tool` messages carry `toolCallId`, which MUST match the `id` of a tool call in
 * the immediately preceding `assistant` message — that link is how the wire
 * formats pair a result to the call that produced it.
 */
export type WorkbenchMessage =
  | { role: "user"; content: string }
  | {
    role: "assistant";
    content: string;
    toolCalls?: WorkbenchToolCall[];
    /** The reply this message came from, for verbatim replay in its turn. */
    replay?: ProviderReplay;
  }
  | {
    role: "tool";
    toolCallId: string;
    name: string;
    content: string;
    /**
     * The call failed (validation denial, execution error). Wire formats that
     * can mark a result as an error (Anthropic `is_error`) surface it, so the
     * model reads the content as a failure to correct rather than as output.
     */
    isError?: boolean;
    /**
     * The result's original length in characters when the engine cut it to
     * fit the model's context window (`content` then ends with the engine's
     * marker). Engine provenance, never on the wire: adapters map the fields
     * they send by name. Absent on a result the engine did not cut, so a
     * result whose own text resembles the marker is never read as one.
     */
    trimmedFrom?: number;
  };

export interface WorkbenchCallTimings {
  responseHeadersMs: number;
  timeToFirstTokenMs?: number;
  generationMs?: number;
  timePerOutputTokenMs?: number;
  totalMs: number;
}

export type FetchLike = typeof fetch;

export interface WorkbenchTurnParams {
  systemPrompt: string;
  prompt: string;
  /**
   * Multi-step conversation history (user/assistant/tool), excluding the system
   * prompt. When present and non-empty it supersedes `prompt` as the conversation
   * the model sees; `prompt` remains the first-turn seed and the fallback for
   * adapters without history mapping (Google, which never emits tool calls and so
   * never loops). Adapters that loop (OpenAI-compatible, Anthropic) build their
   * wire request from this.
   */
  messages?: WorkbenchMessage[];
  routing: WorkbenchRoutingOptions;
  /**
   * Engine default model, applied when routing specifies no model/tier/hint —
   * so this (authoritative) selection agrees with the boundary's instead of
   * falling back to the registry local default. Threaded from config.
   */
  defaultModelId?: string | null;
  /** The catalog to route against (the caller loads it from the store). */
  models: WorkbenchModel[];
  onTextDelta?: (delta: string) => void;
  jsonObject?: boolean;
  tools?: WorkbenchToolDefinition[];
  /** Definitions used only to serialize historical tool-call names. */
  historyTools?: WorkbenchToolDefinition[];
  abortSignal?: AbortSignal;
  now?: () => number;
  fetchFn?: HttpTransport;
  getEnv?: (name: string) => string | undefined;
  sessionId?: string;
  maxOutputTokens?: number;
}
