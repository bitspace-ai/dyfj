/**
 * The provider-facing turn types: the catalog model, routing options and
 * selection, the turn parameters and result, the agent-loop message shape and
 * tool definitions. Plain data; no behavior.
 */
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

export interface WorkbenchTurnResult {
  text: string;
  model: WorkbenchModel;
  selection: WorkbenchSelection;
  toolCalls?: WorkbenchToolCall[];
  usage: {
    input: number;
    output: number;
    cost: { total: number };
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
  /** Safe metadata for repeated unmatched textual tool-call wrapper openings. */
  unparsedToolCallMarkup?: {
    /** Bounded count of unmatched exact `<tool_call>` openings. */
    count: number;
    countIsLowerBound: boolean;
  };
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
  | { role: "assistant"; content: string; toolCalls?: WorkbenchToolCall[] }
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
