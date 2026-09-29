/**
 * Turn-client fixtures for the `dyfj` client's tests: a receipt, the runtime
 * events a stream carries, and scripted socket connectors that stream frames,
 * run turns in sequence, or ask for a mid-turn approval.
 */

import type {
  SupersedingRetryStartedEvent,
  TurnReceipt,
  UnparsedToolCallMarkupDetectedEvent,
} from "../../src/contract/mod.ts";
import type { ToolApprovalVerdict } from "../../src/transport/mod.ts";
import type { ConnectFn } from "../../src/cli/io.ts";

type TurnResult = TurnReceipt;

export function turnResult(overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    sessionId: "01CLISESSION0000000000000000",
    traceId: "0123456789abcdef0123456789abcdef",
    stopReason: "stop",
    text: "Workbench says hello.",
    receipt: "Workbench receipt",
    model: {
      displayName: "Qwen3 Coder 30B",
      slug: "mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit",
      provider: "mlx-lm",
      api: "openai-completions",
      tier: 0,
    },
    route: { reason: "default" },
    cost: { estimatedUsd: 0, totalUsd: 0, paidInferenceUsed: false },
    tokens: {
      input: 12,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalCalls: 1,
    },
    agent: { toolStepsUsed: 0, maxToolSteps: 32, limitReached: false },
    context: { sources: [] },
    ...overrides,
  };
}

export type TurnFrame =
  | { t: "delta"; text: string }
  | { t: "event"; event: Record<string, unknown> };

/**
 * The wire shape of the superseding-retry signal — `satisfies` pins the
 * fixture to the canonical contract type, so field drift breaks compile here.
 */
export function supersedeEvent(): Record<string, unknown> {
  return {
    type: "supersedingRetryStarted",
    sessionId: "01CLISESSION0000000000000000",
    modelSlug: "mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit",
    reason: "context_overflow_recovery",
  } satisfies SupersedingRetryStartedEvent;
}

export function unparsedMarkupEvent(): Record<string, unknown> {
  return {
    type: "unparsedToolCallMarkupDetected",
    sessionId: "01CLISESSION0000000000000000",
    count: 64,
    countIsLowerBound: true,
  } satisfies UnparsedToolCallMarkupDetectedEvent;
}

/** A fake UDS connect that streams the given frames, then resolves `turn`. */
export function fakeTurnConnect(frames: TurnFrame[], r: TurnResult): ConnectFn {
  return (_socketPath: string, options) =>
    Promise.resolve({
      request: (method: string) => {
        if (method === "turn") {
          for (const f of frames) {
            if (f.t === "delta" || f.t === "event") options?.onStream?.(f);
          }
          return Promise.resolve(r);
        }
        return Promise.resolve(undefined);
      },
      close: () => {},
    });
}

export function sequentialTurnConnect(
  turns: Array<{ frames?: TurnFrame[]; result?: TurnResult; error?: unknown }>,
): { connect: ConnectFn; params: unknown[] } {
  let i = 0;
  const params: unknown[] = [];
  const connect: ConnectFn = (_socketPath, options) =>
    Promise.resolve({
      request: (method: string, requestParams?: unknown) => {
        if (method === "turn") {
          params.push(requestParams);
          const turn = turns[i++] ?? {};
          if (turn.error !== undefined) return Promise.reject(turn.error);
          for (const f of turn.frames ?? []) {
            if (f.t === "delta" || f.t === "event") options?.onStream?.(f);
          }
          return Promise.resolve(turn.result ?? turnResult());
        }
        return Promise.resolve(undefined);
      },
      close: () => {},
    });
  return { connect, params };
}

/** A fake UDS connect whose `turn` asks for approval mid-call, capturing the verdict. */
export function fakeApprovalConnect(
  request: unknown,
  r: TurnResult,
  captured: { verdict?: ToolApprovalVerdict },
): ConnectFn {
  return (_socketPath: string, options) =>
    Promise.resolve({
      request: async (method: string) => {
        if (method === "turn") {
          captured.verdict = await options?.onApproval?.(request);
          return r;
        }
        return undefined;
      },
      close: () => {},
    });
}
