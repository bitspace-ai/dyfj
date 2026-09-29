/**
 * The client side of a turn over the UDS seam: the request body, the socket
 * turn that streams frames to its handlers, and turn cancellation.
 */

import { DomainError, type TurnReceipt } from "../contract/mod.ts";
import {
  connectUnixClient,
  type ToolApprovalVerdict,
  type UnixClientOptions,
} from "../transport/mod.ts";
import type { CliConfig } from "./args.ts";
import type { ConnectFn } from "./io.ts";

// ── Seam contract (shared with the server) ──────────────────────────
// The receipt and stream frame shapes are defined once in contract/turn.ts and
// imported by both sides, so this thin client can never silently drift from
// what the server sends. Type imports are erased at compile, and the one value
// import (`DomainError`, the base of the cancellation error) comes from that
// dependency-free contract module, keeping the binary engine-free.

/** The receipt a turn carries. Canonical definition: the shared seam contract. */
export type TurnResult = TurnReceipt;

export interface TurnRequest {
  prompt: string;
  turnId?: string;
  mode?: "turn" | "ask" | "next-work";
  routingOptions?: {
    modelId?: string;
    tier?: 0 | 1 | 2;
    hint?: "code" | "chat" | "reasoning";
    fast?: boolean;
  };
  sessionId?: string;
  /** Working directory to scope the server's read-only file tools to. */
  workspace?: string;
  /** Experimental external-agent profile selector. */
  runner?: "fixture" | "codex-chatgpt";
  /**
   * Per-turn opt-in to paid (hosted) inference. The engine honors it only on the
   * loopback transport AND only when set — a remote caller can never approve spend.
   */
  approvePaidInference?: boolean;
}

export function buildTurnBody(
  prompt: string,
  config: CliConfig,
  sessionId?: string,
): TurnRequest {
  const routingOptions: NonNullable<TurnRequest["routingOptions"]> = {};
  if (config.runner === undefined) {
    if (config.model !== undefined) routingOptions.modelId = config.model;
    if (config.tier !== undefined) routingOptions.tier = config.tier;
    if (config.hint !== undefined) routingOptions.hint = config.hint;
    if (config.fast !== undefined) routingOptions.fast = config.fast;
  }

  const body: TurnRequest = { prompt, mode: config.mode };
  if (Object.keys(routingOptions).length > 0) {
    body.routingOptions = routingOptions;
  }
  if (config.runner !== undefined) body.runner = config.runner;
  if (sessionId !== undefined) body.sessionId = sessionId;
  // Send the workspace only when establishing a NEW session (no sessionId): the
  // server persists it on the session row, and resumed turns read it back, so
  // the cwd is sent once on init rather than re-sent every turn. The UDS seam
  // is local, so the implicit cwd default is always eligible.
  if (config.workspace !== undefined && sessionId === undefined) {
    body.workspace = config.workspace;
  }
  // Per-turn paid opt-in; the engine ignores it on non-loopback transports.
  if (config.approvePaid) body.approvePaidInference = true;
  return body;
}

export const TURN_CANCELLATION_TIMEOUT_MS = 5_000;
export const TURN_CANCELLATION_SETTLE_TIMEOUT_MS = 30_000;

export class TurnCancellationUncertainError extends DomainError {}

/**
 * Run a turn over the UDS/JSON-RPC seam: forward `stream` notifications to the
 * handlers and resolve with the receipt (the RPC result). Over UDS there is
 * no `done`/`error` frame — the receipt is the result, errors are RPC errors.
 */
export async function socketTurn(
  config: CliConfig,
  body: TurnRequest,
  handlers: {
    onDelta?: (text: string) => void;
    onEvent?: (event: Record<string, unknown>) => void;
    onApproval?: (
      request: unknown,
    ) => Promise<ToolApprovalVerdict> | ToolApprovalVerdict;
    abortSignal?: AbortSignal;
    onConnected?: () => void;
    cancellationTimeoutMs?: number;
    cancellationSettleTimeoutMs?: number;
  } = {},
  connect: ConnectFn = connectUnixClient,
): Promise<TurnResult> {
  const turnId = body.turnId ?? crypto.randomUUID();
  const clientOptions: UnixClientOptions = {};
  let turnAbortedEvent: Record<string, unknown> | undefined;
  if (handlers.onDelta !== undefined || handlers.onEvent !== undefined) {
    clientOptions.onStream = (params) => {
      if (typeof params !== "object" || params === null) return;
      const frame = params as {
        t?: unknown;
        text?: unknown;
        event?: unknown;
      };
      if (frame.t === "delta" && typeof frame.text === "string") {
        handlers.onDelta?.(frame.text);
      } else if (
        frame.t === "event" &&
        typeof frame.event === "object" &&
        frame.event !== null &&
        !Array.isArray(frame.event)
      ) {
        const event = frame.event as Record<string, unknown>;
        if (
          event.type === "turnAborted" &&
          (
            typeof event.sessionId !== "string" ||
            typeof event.traceId !== "string" ||
            event.turnId !== turnId
          )
        ) {
          return;
        }
        if (event.type === "turnAborted") {
          turnAbortedEvent = event;
          return;
        }
        handlers.onEvent?.(event);
      }
    };
  }
  if (handlers.onApproval) clientOptions.onApproval = handlers.onApproval;
  const client = await connect(config.socket, clientOptions);
  let rejectCancellation!: (error: DomainError) => void;
  const cancellationFailure = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  let cancel: Promise<unknown> | undefined;
  let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const cancellationError = () =>
    new TurnCancellationUncertainError(
      "turn cancellation was not acknowledged; restart the runtime before retrying",
    );
  const cancellationSettleError = () =>
    new TurnCancellationUncertainError(
      "turn did not finish after cancellation was acknowledged; remote work may still be running, so restart the runtime before retrying",
    );
  const cancellationDeclinedSettleError = () =>
    new TurnCancellationUncertainError(
      "turn did not finish after cancellation was declined; remote work may still be running, so restart the runtime before retrying",
    );
  const requestCancel = () => {
    if (cancel !== undefined) return;
    cancellationTimer = setTimeout(() => {
      rejectCancellation(cancellationError());
    }, handlers.cancellationTimeoutMs ?? TURN_CANCELLATION_TIMEOUT_MS);
    cancel = Promise.resolve()
      .then(() => client.request("turn/cancel", { turnId }))
      .then(
        (result) => {
          clearTimeout(cancellationTimer);
          if (typeof result !== "object" || result === null) {
            rejectCancellation(cancellationError());
          } else if (!settled) {
            const cancelled = (result as Record<string, unknown>).cancelled;
            if (cancelled !== true && cancelled !== false) {
              rejectCancellation(cancellationError());
              return result;
            }
            cancellationTimer = setTimeout(
              () => {
                rejectCancellation(
                  cancelled
                    ? cancellationSettleError()
                    : cancellationDeclinedSettleError(),
                );
              },
              handlers.cancellationSettleTimeoutMs ??
                TURN_CANCELLATION_SETTLE_TIMEOUT_MS,
            );
          }
          return result;
        },
        () => {
          clearTimeout(cancellationTimer);
          rejectCancellation(cancellationError());
        },
      );
  };
  try {
    if (handlers.abortSignal?.aborted) {
      throw new DomainError("turn interrupted before dispatch");
    }
    handlers.onConnected?.();
    const turn = client.request("turn", { ...body, turnId });
    handlers.abortSignal?.addEventListener("abort", requestCancel, {
      once: true,
    });
    if (handlers.abortSignal?.aborted) requestCancel();
    const result = await Promise.race([
      turn as Promise<TurnResult>,
      cancellationFailure,
    ]);
    if (result.stopReason === "aborted") {
      const matchingAbortEvent = turnAbortedEvent?.sessionId ===
            result.sessionId &&
          turnAbortedEvent.traceId === result.traceId
        ? turnAbortedEvent
        : undefined;
      handlers.onEvent?.(
        matchingAbortEvent ?? {
          type: "turnAborted",
          sessionId: result.sessionId,
          traceId: result.traceId,
          turnId,
        },
      );
    }
    return result;
  } finally {
    settled = true;
    clearTimeout(cancellationTimer);
    handlers.abortSignal?.removeEventListener("abort", requestCancel);
    client.close();
  }
}
