/**
 * The `ProviderAdapter` interface: one implementation per API family
 * (`specs/01-architecture.md` section 5.2).
 *
 * The registry selects the model, finds the adapter that serves its provider,
 * checks the base URL with `validateBaseUrl`, and then calls `run`, which owns
 * everything from the credential check to the parsed result. Every adapter
 * passes the provider conformance kit in `testing/conformance/provider-adapter.ts`.
 */
import type { Env } from "../config/mod.ts";
import type { DomainError } from "../contract/mod.ts";
import type { HttpTransport } from "./http.ts";
import type {
  WorkbenchModel,
  WorkbenchSelection,
  WorkbenchTurnParams,
  WorkbenchTurnResult,
} from "./types.ts";

/**
 * A source of monotonic milliseconds for request timings (the runtime passes
 * `performance.now`). Distinct from the wall-clock `Clock` port in `kernel/`:
 * only differences between readings mean anything.
 */
export interface MonotonicClock {
  now(): number;
}

/** One live output frame. Streamed text is the only frame adapters emit. */
export interface ProviderFrame {
  type: "text_delta";
  delta: string;
}

/**
 * Everything an adapter touches outside its own code. A turn streams exactly
 * when `onFrame` is present.
 */
export interface ProviderIO {
  fetch: HttpTransport;
  clock: MonotonicClock;
  /** Where hosted adapters read their credential. */
  env: Env;
  onFrame?: (frame: ProviderFrame) => void;
  signal?: AbortSignal;
}

/** The turn an adapter runs: the selected model plus the conversation. */
export type ProviderTurnRequest =
  & Pick<
    WorkbenchTurnParams,
    | "systemPrompt"
    | "prompt"
    | "messages"
    | "jsonObject"
    | "tools"
    | "historyTools"
    | "sessionId"
    | "maxOutputTokens"
  >
  & {
    model: WorkbenchModel;
    selection: WorkbenchSelection;
  };

export type BaseUrlCheck = { ok: true } | { ok: false; error: DomainError };

export interface ProviderAdapter {
  /** The API family this adapter speaks. */
  readonly api: string;
  /** The catalog `provider` values this adapter serves. */
  readonly providers: ReadonlySet<string>;
  /** Whether a streamed turn can also return tool calls. */
  readonly streamsToolCalls: boolean;
  /**
   * Whether the wire request is built from `messages`, so a turn can be
   * retried with a rewritten transcript.
   */
  readonly supportsTranscriptRetry: boolean;
  /**
   * The output-token ceiling a request carries when the caller asks for none,
   * or `undefined` to send no ceiling beyond the catalog limit.
   */
  defaultOutputTokens(model: WorkbenchModel): number | undefined;
  /** Where this model's requests may go, checked before any request. */
  validateBaseUrl(model: WorkbenchModel): BaseUrlCheck;
  run(request: ProviderTurnRequest, io: ProviderIO): Promise<
    WorkbenchTurnResult
  >;
}
