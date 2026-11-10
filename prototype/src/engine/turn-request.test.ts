import assert from "node:assert/strict";
import { describe, it, test } from "node:test";
import {
  PAID_ESCALATION_NOT_APPROVED,
  PAID_ESCALATION_REMOTE_DENIED,
  paidEscalationVerdict,
  parseAdditionalRoots,
  parseBudgetOverride,
  resolveTurnFromBody,
} from "./turn-request.ts";

const SESSION_ID = "01ABCDEF0123456789ABCDEF01";
const TURN_ID = "123e4567-e89b-42d3-a456-426614174000";

function match(actual: unknown, expected: Record<string, any>): void {
  assert.partialDeepStrictEqual(actual as Record<string, unknown>, expected);
}

test("resolveTurnFromBody selects the fixture runner only for a loopback turn", () => {
  match(resolveTurnFromBody({ prompt: "hi", runner: "fixture" }, true), {
    runtimeInput: { runner: { kind: "acp", profile: "fixture" } },
  });
  match(resolveTurnFromBody({ prompt: "hi", runner: "fixture" }, false), {
    status: 403,
  });
});

test("resolveTurnFromBody selects the Codex ChatGPT runner only for a trusted loopback workspace", () => {
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
    {
      status: 403,
      error: "codex-chatgpt requires explicit workspace trust: it runs " +
        "with the workspace's instructions. Set " +
        "DYFJ_TRUST_WORKSPACE_INSTRUCTIONS=1 in the runtime's environment " +
        "(prototype/.env), restart the runtime, then retry",
    },
  );
  match(
    resolveTurnFromBody({ prompt: "hi", runner: "codex-chatgpt" }, false, {
      trustWorkspaceInstructions: true,
    }),
    { status: 403 },
  );
});

test("resolveTurnFromBody allows the Codex ChatGPT route with session resume", () => {
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

test("resolveTurnFromBody keeps external runner selection distinct from model routing", () => {
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

test("resolveTurnFromBody carries a valid client turn id into the runtime input", () => {
  match(resolveTurnFromBody({ prompt: "hi", turnId: TURN_ID }, true), {
    runtimeInput: { turnId: TURN_ID },
  });
});

test("resolveTurnFromBody rejects a malformed turn id", () => {
  match(resolveTurnFromBody({ prompt: "hi", turnId: "turn-1" }, true), {
    status: 400,
    error: "turnId must be a UUID",
  });
});

test("resolveTurnFromBody: explicit approvePaidInference true opts in", () => {
  match(
    resolveTurnFromBody({ prompt: "hi", approvePaidInference: true }, true),
    { approvePaidInference: true },
  );
});

test("resolveTurnFromBody: explicit approvePaidInference false overrides the standing default", () => {
  match(
    resolveTurnFromBody({ prompt: "hi", approvePaidInference: false }, true, {
      approvePaidDefault: true,
    }),
    { approvePaidInference: false },
  );
});

test("resolveTurnFromBody: loopback inherits approvePaidDefault when the request omits opt-in", () => {
  match(
    resolveTurnFromBody({ prompt: "hi" }, true, { approvePaidDefault: true }),
    { approvePaidInference: true },
  );
});

test("resolveTurnFromBody: non-loopback never inherits the standing default", () => {
  match(
    resolveTurnFromBody({ prompt: "hi" }, false, { approvePaidDefault: true }),
    { approvePaidInference: false },
  );
});

test("resolveTurnFromBody: loopback without a standing default stays off", () => {
  match(resolveTurnFromBody({ prompt: "hi" }, true), {
    approvePaidInference: false,
  });
});

test("resolveTurnFromBody applies a budget override on loopback only", () => {
  const budget = { sessionLimitUsd: 2, perCallLimitUsd: 0.5, dailyLimitUsd: 9 };
  match(resolveTurnFromBody({ prompt: "hi", budget }, true), {
    runtimeInput: budget,
  });
  const remote = resolveTurnFromBody({ prompt: "hi", budget }, false);
  if ("error" in remote) throw new Error(remote.error);
  assert.deepStrictEqual(remote.runtimeInput.sessionLimitUsd, undefined);
  assert.deepStrictEqual(remote.runtimeInput.perCallLimitUsd, undefined);
  assert.deepStrictEqual(remote.runtimeInput.dailyLimitUsd, undefined);
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

test("resolveTurnFromBody takes a session's tool-step limit up to the ceiling", () => {
  const options = { maxToolSteps: 32, maxToolStepsCeiling: 48 };
  match(resolveTurnFromBody({ prompt: "hi", maxToolSteps: 48 }, true, options), {
    maxToolSteps: 48,
  });
  match(resolveTurnFromBody({ prompt: "hi", maxToolSteps: 49 }, true, options), {
    status: 400,
    error: "maxToolSteps 49 is above the tool-step ceiling of 48",
  });
  const omitted = resolveTurnFromBody({ prompt: "hi" }, true, options);
  assert.deepStrictEqual("maxToolSteps" in omitted, false);
  for (const value of [0, -1, 1.5, "8", null]) {
    match(resolveTurnFromBody({ prompt: "hi", maxToolSteps: value }, true, options), {
      status: 400,
      error: "maxToolSteps must be a positive integer",
    });
  }
  // The ceiling defaults to the declared 64 when the caller passes none.
  match(resolveTurnFromBody({ prompt: "hi", maxToolSteps: 65 }, true), {
    status: 400,
    error: "maxToolSteps 65 is above the tool-step ceiling of 64",
  });
});

test("resolveTurnFromBody lets a remote caller lower the tool-step limit but not raise it", () => {
  const options = { maxToolSteps: 32, maxToolStepsCeiling: 64 };
  match(resolveTurnFromBody({ prompt: "hi", maxToolSteps: 4 }, false, options), {
    maxToolSteps: 4,
  });
  match(resolveTurnFromBody({ prompt: "hi", maxToolSteps: 32 }, false, options), {
    maxToolSteps: 32,
  });
  match(resolveTurnFromBody({ prompt: "hi", maxToolSteps: 33 }, false, options), {
    status: 403,
    error: "remote callers may not raise the tool-step limit",
  });
});

test("parseBudgetOverride rejects non-objects and out-of-range values", () => {
  assert.deepStrictEqual(parseBudgetOverride([]), {
    error: "budget must be an object",
  });
  assert.deepStrictEqual(parseBudgetOverride({ dailyLimitUsd: 1001 }), {
    error: "budget.dailyLimitUsd must be a positive number up to 1000",
  });
  assert.deepStrictEqual(parseBudgetOverride({ perCallLimitUsd: 0.25 }), {
    perCallLimitUsd: 0.25,
  });
});

test("resolveTurnFromBody honors a loopback one-shot release", () => {
  match(
    resolveTurnFromBody(
      { prompt: "hi", releaseExternalAgentSession: true },
      true,
    ),
    { releaseExternalAgentSession: true },
  );
  match(resolveTurnFromBody({ prompt: "hi" }, true), {
    releaseExternalAgentSession: false,
  });
  match(
    resolveTurnFromBody(
      { prompt: "hi", releaseExternalAgentSession: true },
      false,
    ),
    { releaseExternalAgentSession: false },
  );
  match(
    resolveTurnFromBody(
      { prompt: "hi", releaseExternalAgentSession: "yes" },
      true,
    ),
    { status: 400, error: "releaseExternalAgentSession must be a boolean" },
  );
});

test("resolveTurnFromBody validates the session id shape", () => {
  match(resolveTurnFromBody({ prompt: "hi", sessionId: "../etc" }, true), {
    status: 400,
    error: "invalid session id",
  });
  match(resolveTurnFromBody({ prompt: "hi", sessionId: SESSION_ID }, true), {
    sessionId: SESSION_ID,
  });
});

test("paidEscalationVerdict denies remote callers even when they opt in", () => {
  assert.deepStrictEqual(paidEscalationVerdict(false, true), {
    decision: "deny",
    reason: PAID_ESCALATION_REMOTE_DENIED,
  });
});

test("paidEscalationVerdict denies a loopback caller that did not opt in", () => {
  assert.deepStrictEqual(paidEscalationVerdict(true, false), {
    decision: "deny",
    reason: PAID_ESCALATION_NOT_APPROVED,
  });
  // The refusal says how to give the consent it lacked.
  assert.match(PAID_ESCALATION_NOT_APPROVED, /--approve-paid/);
  assert.deepStrictEqual(paidEscalationVerdict(true, true), {
    decision: "approve",
  });
});

test("resolveTurnFromBody accepts each Codex reasoning effort and refuses any other value", () => {
  for (const reasoningEffort of ["low", "medium", "high", "xhigh"]) {
    match(
      resolveTurnFromBody({ prompt: "hi", routingOptions: { reasoningEffort } }, true),
      { runtimeInput: { routingOptions: { reasoningEffort } } },
    );
  }
  for (const reasoningEffort of ["minimal", "XHIGH", "", 3]) {
    match(
      resolveTurnFromBody({ prompt: "hi", routingOptions: { reasoningEffort } }, true),
      {
        status: 400,
        error: "routingOptions.reasoningEffort must be low, medium, high, or xhigh",
      },
    );
  }
});

test("resolveTurnFromBody lets an explicit Codex runner carry a reasoning effort", () => {
  match(
    resolveTurnFromBody({
      prompt: "hi",
      runner: "codex-chatgpt",
      routingOptions: { reasoningEffort: "xhigh" },
    }, true, { trustWorkspaceInstructions: true }),
    {
      runtimeInput: {
        runner: { kind: "acp", profile: "codex-chatgpt" },
        routingOptions: { reasoningEffort: "xhigh" },
      },
    },
  );
});

describe("parseAdditionalRoots", () => {
  it("accepts absolute roots, read-only when asked", () => {
    assert.deepStrictEqual(
      parseAdditionalRoots([{ path: "/a" }, { path: "/b", readOnly: true }]),
      { roots: [{ path: "/a", readOnly: false }, { path: "/b", readOnly: true }] },
    );
    assert.deepStrictEqual(parseAdditionalRoots(undefined), { roots: [] });
  });

  it("on Windows, takes only drive- or UNC-qualified paths", () => {
    for (const path of ["C:\\repo", "D:/repo", "\\\\host\\share\\repo"]) {
      assert.ok("roots" in parseAdditionalRoots([{ path }], "win32"), path);
    }
    for (const path of ["\\repo", "/repo", "D:repo"]) {
      assert.ok("error" in parseAdditionalRoots([{ path }], "win32"), path);
    }
  });

  it("refuses a malformed list", () => {
    for (
      const value of [
        "/a",
        [{ path: "relative" }],
        [{ path: "/a", readOnly: "yes" }],
        [{ path: "/a", extra: 1 }],
        [null],
        Array.from({ length: 17 }, () => ({ path: "/a" })),
      ]
    ) {
      assert.ok("error" in parseAdditionalRoots(value), JSON.stringify(value));
    }
  });
});
