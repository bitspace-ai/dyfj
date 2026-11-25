/**
 * Component tests for `runWorkbenchRuntime`'s dispatch: an ACP route goes to
 * the external-agent runner port, gated by workspace trust and the paid
 * preflight, and fails closed when no runner is bound. The runner is a
 * recording fake; the ACP runtime behind the real port has its own tests.
 */
import { captureRejection } from "../../testing/assertions/captured.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { engineServices, LOCAL_MODEL } from "../../testing/builders/engine.ts";
import {
  type AcpRunnerSelection,
  DomainError,
  type ExternalAgentWorkbenchRuntimeResult,
} from "../contract/mod.ts";
import type { ModelSeed } from "../store/mod.ts";
import type { WorkspaceConfigResolver } from "../config/mod.ts";
import { PaidEscalationDeclinedError } from "./errors.ts";
import { runWorkbenchRuntime } from "./native-runner.ts";
import type {
  ExternalAgentRunner,
  WorkbenchRuntimeInput,
} from "./runtime-types.ts";

type ExternalAgentRuntimeInput = WorkbenchRuntimeInput & {
  runner: AcpRunnerSelection;
};

const ACP_FIXTURE: ModelSeed = {
  slug: "fixture",
  display_name: "ACP Fixture",
  provider: "fixture",
  api: "acp",
  base_url: "local_stdio",
  tier: 0,
  context_window: 32768,
  max_output_tokens: 4096,
  capabilities: ["text"],
};

const CODEX_SOL: ModelSeed = {
  slug: "codex-chatgpt/gpt-6.1-sol",
  display_name: "GPT-6.1 Sol (Codex)",
  provider: "codex-chatgpt",
  api: "acp",
  base_url: "local_stdio",
  tier: 2,
  cost_input: 1.25,
  cost_output: 10,
  context_window: 1050000,
  max_output_tokens: 128000,
  capabilities: ["text", "code", "reasoning"],
};

const CODEX_TERRA: ModelSeed = {
  slug: "codex-chatgpt/gpt-6.1-terra",
  display_name: "GPT-6.1 Terra",
  provider: "codex-chatgpt",
  api: "acp",
  base_url: "local_stdio",
  tier: 2,
  cost_input: 1.25,
  cost_output: 10,
  context_window: 1050000,
  max_output_tokens: 128000,
  capabilities: ["text", "fast-speed"],
};

const APPROVE = () => Promise.resolve({ decision: "approve" as const });

/** A runner port that records each input and answers with a stub result. */
function recordingRunner(): ExternalAgentRunner & {
  calls: ExternalAgentRuntimeInput[];
} {
  const calls: ExternalAgentRuntimeInput[] = [];
  return {
    calls,
    run: (input) => {
      calls.push(input);
      return Promise.resolve({
        sessionId: input.sessionId ?? "01ACPSTUB00000000000000001",
        traceId: "0123456789abcdef0123456789abcdef",
        stopReason: "stop",
        text: "stubbed",
        receipt: `stubbed receipt: ${input.runner.profile}`,
        route: { reason: "explicit_external_agent" },
      } as unknown as ExternalAgentWorkbenchRuntimeResult);
    },
  };
}

function dispatch(
  input: Partial<WorkbenchRuntimeInput>,
  options: {
    models?: ModelSeed[];
    runner?: ExternalAgentRunner;
    workspaceConfig?: WorkspaceConfigResolver;
  } = {},
) {
  const run = engineServices([], {
    models: [LOCAL_MODEL, ...(options.models ?? [])],
  });
  return runWorkbenchRuntime({
    mode: "turn",
    prompt: "inspect",
    routingOptions: {},
    ...input,
  }, {
    ...run.services,
    ...(options.runner === undefined
      ? {}
      : { externalAgentRunner: options.runner }),
    ...(options.workspaceConfig === undefined
      ? {}
      : { workspaceConfig: options.workspaceConfig }),
  });
}

const NO_RUNNER = "No external-agent runner is configured";

test("fails closed when an explicit ACP route has no runner bound", async () => {
  // A direct caller that omits the runner service gets the fixed error,
  // never a lazily loaded runner.
  const error = await captureRejection(() =>
    dispatch({
      runner: { kind: "acp", profile: "fixture" },
      trustWorkspaceInstructions: true,
    })
  );
  assert.ok(error instanceof DomainError);
  assert.deepStrictEqual(error.message, NO_RUNNER);
});

test("fails closed when model selection routes to ACP with no runner bound", async () => {
  await assert.rejects(
    () =>
      dispatch({
        routingOptions: { modelId: "fixture" },
        trustWorkspaceInstructions: true,
      }, { models: [ACP_FIXTURE] }),
    (error: unknown) =>
      error instanceof DomainError && error.message.includes(NO_RUNNER),
  );
});

test("rejects the Codex ChatGPT route without explicit workspace trust", async () => {
  const runner = recordingRunner();
  await assert.rejects(
    () =>
      dispatch({
        runner: { kind: "acp", profile: "codex-chatgpt" },
        trustWorkspaceInstructions: false,
      }, { runner }),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("codex-chatgpt requires explicit workspace trust"),
  );
  assert.deepStrictEqual(runner.calls.length, 0);
});

test("rejects the Codex ChatGPT route via model selection without explicit workspace trust", async () => {
  const runner = recordingRunner();
  await assert.rejects(
    () =>
      dispatch({
        routingOptions: { modelId: CODEX_SOL.slug },
        trustWorkspaceInstructions: false,
      }, { models: [CODEX_SOL], runner }),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("codex-chatgpt requires explicit workspace trust"),
  );
  assert.deepStrictEqual(runner.calls.length, 0);
});

test("rejects an unapproved explicit Codex ChatGPT runner request with PaidEscalationDeclinedError", async () => {
  const runner = recordingRunner();
  await assert.rejects(
    () =>
      dispatch({
        runner: { kind: "acp", profile: "codex-chatgpt" },
        trustWorkspaceInstructions: true,
      }, { runner }),
    PaidEscalationDeclinedError,
  );
  assert.deepStrictEqual(runner.calls.length, 0);
});

test("allows an explicit Codex ChatGPT runner request when paid escalation is confirmed", async () => {
  const runner = recordingRunner();
  const result = await dispatch({
    runner: { kind: "acp", profile: "codex-chatgpt" },
    trustWorkspaceInstructions: true,
    approver: {
      confirmPaidEscalation: APPROVE,
    },
  }, { runner });
  assert.deepStrictEqual(runner.calls.length, 1);
  assert.partialDeepStrictEqual(runner.calls[0], {
    runner: { kind: "acp", profile: "codex-chatgpt" },
  });
  assert.deepStrictEqual(result.text, "stubbed");
});

test("rejects an unapproved tier-2 ACP request with PaidEscalationDeclinedError", async () => {
  const runner = recordingRunner();
  await assert.rejects(
    () =>
      dispatch({
        prompt: "test unapproved paid",
        routingOptions: { modelId: CODEX_TERRA.slug },
        trustWorkspaceInstructions: true,
      }, { models: [CODEX_TERRA], runner }),
    PaidEscalationDeclinedError,
  );
  assert.deepStrictEqual(runner.calls.length, 0);
});

test("allows a tier-2 ACP request when paid escalation is confirmed", async () => {
  const runner = recordingRunner();
  const result = await dispatch({
    prompt: "test approved paid",
    routingOptions: { modelId: CODEX_TERRA.slug },
    trustWorkspaceInstructions: true,
    approver: {
      confirmPaidEscalation: APPROVE,
    },
  }, { models: [CODEX_TERRA], runner });
  assert.deepStrictEqual(runner.calls.length, 1);
  assert.partialDeepStrictEqual(runner.calls[0], {
    prompt: "test approved paid",
    runner: { kind: "acp", profile: "codex-chatgpt" },
  });
  assert.deepStrictEqual(result.text, "stubbed");
});

test("routes an ACP model selection to the external agent runner", async () => {
  const runner = recordingRunner();
  const result = await dispatch({
    prompt: "test acp dispatch",
    routingOptions: { modelId: "fixture" },
    trustWorkspaceInstructions: true,
  }, { models: [ACP_FIXTURE], runner });
  assert.deepStrictEqual(runner.calls.length, 1);
  assert.partialDeepStrictEqual(runner.calls[0], {
    prompt: "test acp dispatch",
    runner: { kind: "acp", profile: "fixture" },
  });
  assert.deepStrictEqual(result.receipt, "stubbed receipt: fixture");
});

test("allows resumed session turns on the external agent runner", async () => {
  // The engine hands the resumed session id to the runner; the ACP runtime's
  // own tests cover how it persists and resumes that session.
  const runner = recordingRunner();
  const first = await dispatch({
    prompt: "first turn",
    routingOptions: { modelId: "fixture" },
    trustWorkspaceInstructions: true,
  }, { models: [ACP_FIXTURE], runner });
  const second = await dispatch({
    prompt: "second turn",
    routingOptions: { modelId: "fixture" },
    trustWorkspaceInstructions: true,
    sessionId: first.sessionId,
  }, { models: [ACP_FIXTURE], runner });
  assert.deepStrictEqual(second.sessionId, first.sessionId);
  assert.deepStrictEqual(runner.calls.map((call) => call.prompt), [
    "first turn",
    "second turn",
  ]);
  assert.deepStrictEqual(runner.calls[1].sessionId, first.sessionId);
});

/**
 * A profile stub: the workspace it covers, and what it declares. Every other
 * root resolves to the globals the test passes in.
 */
function workspaceProfiles(
  covered: string,
  profile: { trustInstructions: boolean },
  globals: { trustInstructions: boolean },
): { resolver: WorkspaceConfigResolver; asked: () => string[] } {
  const asked: string[] = [];
  return {
    asked: () => asked,
    resolver: {
      resolve(workspace: string) {
        asked.push(workspace);
        const empty = {
          gate: null,
          publish: null,
          sandbox: { allowDomains: [], denyRead: [] },
          requireWorktree: false,
          dispatch: null,
        };
        return workspace === covered
          ? { ...empty, trustInstructions: profile.trustInstructions, profile: null }
          : { ...empty, trustInstructions: globals.trustInstructions, profile: null };
      },
    },
  };
}

test("a profile that declines instruction trust refuses the Codex route, whatever the global setting says", async () => {
  // The bug: the route trust check read only the global setting, so a runtime
  // with global trust on launched a workspace whose profile declined.
  const runner = recordingRunner();
  const profiles = workspaceProfiles(
    "/work/declined",
    { trustInstructions: false },
    { trustInstructions: true },
  );
  await assert.rejects(
    () =>
      dispatch({
        runner: { kind: "acp", profile: "codex-chatgpt" },
        workspaceRoot: "/work/declined",
        trustWorkspaceInstructions: true,
        approver: { confirmPaidEscalation: APPROVE },
      }, { runner, workspaceConfig: profiles.resolver }),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("codex-chatgpt requires explicit workspace trust"),
  );
  assert.deepStrictEqual(runner.calls.length, 0);
  // The resolved workspace's profile was actually consulted, not the global.
  assert.ok(profiles.asked().includes("/work/declined"));
});

test("a profile that elevates instruction trust admits the Codex route, whatever the global setting says", async () => {
  const runner = recordingRunner();
  const profiles = workspaceProfiles(
    "/work/trusted",
    { trustInstructions: true },
    { trustInstructions: false },
  );
  await dispatch({
    runner: { kind: "acp", profile: "codex-chatgpt" },
    workspaceRoot: "/work/trusted",
    trustWorkspaceInstructions: false,
    approver: { confirmPaidEscalation: APPROVE },
  }, { runner, workspaceConfig: profiles.resolver });
  assert.deepStrictEqual(runner.calls.length, 1);
  // The runner is handed the profile's decision, not the caller's flag: the
  // ACP runtime re-checks trust for itself.
  assert.strictEqual(runner.calls[0]!.trustWorkspaceInstructions, true);
});

test("an unmatched workspace keeps the global instruction-trust setting", async () => {
  const runner = recordingRunner();
  const profiles = workspaceProfiles(
    "/work/trusted",
    { trustInstructions: true },
    { trustInstructions: false },
  );
  await assert.rejects(
    () =>
      dispatch({
        runner: { kind: "acp", profile: "codex-chatgpt" },
        workspaceRoot: "/work/elsewhere",
        trustWorkspaceInstructions: true,
        approver: { confirmPaidEscalation: APPROVE },
      }, { runner, workspaceConfig: profiles.resolver }),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("codex-chatgpt requires explicit workspace trust"),
  );
  assert.deepStrictEqual(runner.calls.length, 0);
});
