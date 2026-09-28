import { assertEquals, assertObjectMatch } from "@std/assert";
import {
  PAID_ESCALATION_NOT_APPROVED,
  PAID_ESCALATION_REMOTE_DENIED,
  paidEscalationVerdict,
  parseBudgetOverride,
  resolveTurnFromBody,
} from "./turn-request.ts";

const SESSION_ID = "01ABCDEF0123456789ABCDEF01";
const TURN_ID = "123e4567-e89b-42d3-a456-426614174000";

// deno-lint-ignore no-explicit-any
function match(actual: unknown, expected: Record<string, any>): void {
  assertObjectMatch(actual as Record<string, unknown>, expected);
}

Deno.test("resolveTurnFromBody selects the fixture runner only for a loopback turn", () => {
  match(resolveTurnFromBody({ prompt: "hi", runner: "fixture" }, true), {
    runtimeInput: { runner: { kind: "acp", profile: "fixture" } },
  });
  match(resolveTurnFromBody({ prompt: "hi", runner: "fixture" }, false), {
    status: 403,
  });
});

Deno.test("resolveTurnFromBody selects the Codex ChatGPT runner only for a trusted loopback workspace", () => {
  match(
    resolveTurnFromBody({ prompt: "hi", runner: "codex-chatgpt" }, true, {
      trustWorkspaceInstructions: true,
    }),
    {
      runtimeInput: {
        runner: { kind: "acp", profile: "codex-chatgpt" },
        trustWorkspaceInstructions: true,
      },
    },
  );
  match(
    resolveTurnFromBody({ prompt: "hi", runner: "codex-chatgpt" }, true, {
      trustWorkspaceInstructions: false,
    }),
    { status: 403, error: "codex-chatgpt requires explicit workspace trust" },
  );
  match(
    resolveTurnFromBody({ prompt: "hi", runner: "codex-chatgpt" }, false, {
      trustWorkspaceInstructions: true,
    }),
    { status: 403 },
  );
});

Deno.test("resolveTurnFromBody allows the Codex ChatGPT route with session resume", () => {
  match(
    resolveTurnFromBody(
      { prompt: "hi", runner: "codex-chatgpt", sessionId: SESSION_ID },
      true,
      { trustWorkspaceInstructions: true },
    ),
    {
      runtimeInput: {
        runner: { kind: "acp", profile: "codex-chatgpt" },
        trustWorkspaceInstructions: true,
      },
      sessionId: SESSION_ID,
    },
  );
});

Deno.test("resolveTurnFromBody keeps external runner selection distinct from model routing", () => {
  match(
    resolveTurnFromBody({
      prompt: "hi",
      runner: "fixture",
      routingOptions: { modelId: "not-a-runner" },
    }, true),
    {
      status: 400,
      error: "runner cannot be combined with model routing options",
    },
  );
});

Deno.test("resolveTurnFromBody carries a valid client turn id into the runtime input", () => {
  match(resolveTurnFromBody({ prompt: "hi", turnId: TURN_ID }, true), {
    runtimeInput: { turnId: TURN_ID },
  });
});

Deno.test("resolveTurnFromBody rejects a malformed turn id", () => {
  match(resolveTurnFromBody({ prompt: "hi", turnId: "turn-1" }, true), {
    status: 400,
    error: "turnId must be a UUID",
  });
});

Deno.test("resolveTurnFromBody: explicit approvePaidInference true opts in", () => {
  match(
    resolveTurnFromBody({ prompt: "hi", approvePaidInference: true }, true),
    { approvePaidInference: true },
  );
});

Deno.test("resolveTurnFromBody: explicit approvePaidInference false overrides the standing default", () => {
  match(
    resolveTurnFromBody({ prompt: "hi", approvePaidInference: false }, true, {
      approvePaidDefault: true,
    }),
    { approvePaidInference: false },
  );
});

Deno.test("resolveTurnFromBody: loopback inherits approvePaidDefault when the request omits opt-in", () => {
  match(
    resolveTurnFromBody({ prompt: "hi" }, true, { approvePaidDefault: true }),
    { approvePaidInference: true },
  );
});

Deno.test("resolveTurnFromBody: non-loopback never inherits the standing default", () => {
  match(
    resolveTurnFromBody({ prompt: "hi" }, false, { approvePaidDefault: true }),
    { approvePaidInference: false },
  );
});

Deno.test("resolveTurnFromBody: loopback without a standing default stays off", () => {
  match(resolveTurnFromBody({ prompt: "hi" }, true), {
    approvePaidInference: false,
  });
});

Deno.test("resolveTurnFromBody applies a budget override on loopback only", () => {
  const budget = { sessionLimitUsd: 2, perCallLimitUsd: 0.5, dailyLimitUsd: 9 };
  match(resolveTurnFromBody({ prompt: "hi", budget }, true), {
    runtimeInput: budget,
  });
  const remote = resolveTurnFromBody({ prompt: "hi", budget }, false);
  if ("error" in remote) throw new Error(remote.error);
  assertEquals(remote.runtimeInput.sessionLimitUsd, undefined);
  assertEquals(remote.runtimeInput.perCallLimitUsd, undefined);
  assertEquals(remote.runtimeInput.dailyLimitUsd, undefined);
  match(
    resolveTurnFromBody(
      { prompt: "hi", budget: { sessionLimitUsd: 0 } },
      false,
    ),
    {
      status: 400,
      error: "budget.sessionLimitUsd must be a positive number up to 1000",
    },
  );
});

Deno.test("parseBudgetOverride rejects non-objects and out-of-range values", () => {
  assertEquals(parseBudgetOverride([]), { error: "budget must be an object" });
  assertEquals(parseBudgetOverride({ dailyLimitUsd: 1001 }), {
    error: "budget.dailyLimitUsd must be a positive number up to 1000",
  });
  assertEquals(parseBudgetOverride({ perCallLimitUsd: 0.25 }), {
    perCallLimitUsd: 0.25,
  });
});

Deno.test("resolveTurnFromBody validates the session id shape", () => {
  match(resolveTurnFromBody({ prompt: "hi", sessionId: "../etc" }, true), {
    status: 400,
    error: "invalid session id",
  });
  match(resolveTurnFromBody({ prompt: "hi", sessionId: SESSION_ID }, true), {
    sessionId: SESSION_ID,
  });
});

Deno.test("paidEscalationVerdict denies remote callers even when they opt in", () => {
  assertEquals(paidEscalationVerdict(false, true), {
    decision: "deny",
    reason: PAID_ESCALATION_REMOTE_DENIED,
  });
});

Deno.test("paidEscalationVerdict denies a loopback caller that did not opt in", () => {
  assertEquals(paidEscalationVerdict(true, false), {
    decision: "deny",
    reason: PAID_ESCALATION_NOT_APPROVED,
  });
  assertEquals(paidEscalationVerdict(true, true), { decision: "approve" });
});
