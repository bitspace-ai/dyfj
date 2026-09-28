/**
 * Component tests for `runWorkbenchRuntime`'s dispatch: an ACP route goes to
 * the external-agent runner port, gated by workspace trust and the paid
 * preflight, and fails closed when no runner is bound. The runner is a
 * recording fake; the ACP runtime behind the real port has its own tests.
 */
import {
  assertEquals,
  assertInstanceOf,
  assertObjectMatch,
  assertRejects,
} from "@std/assert";
import { engineServices, LOCAL_MODEL } from "../../testing/builders/engine.ts";
import {
  type AcpRunnerSelection,
  DomainError,
  type ExternalAgentWorkbenchRuntimeResult,
} from "../contract/mod.ts";
import type { ModelSeed } from "../store/mod.ts";
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
  slug: "codex-chatgpt/gpt-5.6-sol",
  display_name: "GPT-5.6 Sol (Codex)",
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
  slug: "codex-chatgpt/gpt-5.6-terra",
  display_name: "GPT-5.6 Terra",
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
  options: { models?: ModelSeed[]; runner?: ExternalAgentRunner } = {},
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
  });
}

const NO_RUNNER = "No external-agent runner is configured";

Deno.test("fails closed when an explicit ACP route has no runner bound", async () => {
  // A direct caller that omits the runner service gets the fixed error,
  // never a lazily loaded runner.
  const error = await assertRejects(() =>
    dispatch({
      runner: { kind: "acp", profile: "fixture" },
      trustWorkspaceInstructions: true,
    })
  );
  assertInstanceOf(error, DomainError);
  assertEquals(error.message, NO_RUNNER);
});

Deno.test("fails closed when model selection routes to ACP with no runner bound", async () => {
  await assertRejects(
    () =>
      dispatch({
        routingOptions: { modelId: "fixture" },
        trustWorkspaceInstructions: true,
      }, { models: [ACP_FIXTURE] }),
    DomainError,
    NO_RUNNER,
  );
});

Deno.test("rejects the Codex ChatGPT route without explicit workspace trust", async () => {
  const runner = recordingRunner();
  await assertRejects(
    () =>
      dispatch({
        runner: { kind: "acp", profile: "codex-chatgpt" },
        trustWorkspaceInstructions: false,
      }, { runner }),
    Error,
    "codex-chatgpt requires explicit workspace trust",
  );
  assertEquals(runner.calls.length, 0);
});

Deno.test("rejects the Codex ChatGPT route via model selection without explicit workspace trust", async () => {
  const runner = recordingRunner();
  await assertRejects(
    () =>
      dispatch({
        routingOptions: { modelId: CODEX_SOL.slug },
        trustWorkspaceInstructions: false,
      }, { models: [CODEX_SOL], runner }),
    Error,
    "codex-chatgpt requires explicit workspace trust",
  );
  assertEquals(runner.calls.length, 0);
});

Deno.test("rejects an unapproved explicit Codex ChatGPT runner request with PaidEscalationDeclinedError", async () => {
  const runner = recordingRunner();
  await assertRejects(
    () =>
      dispatch({
        runner: { kind: "acp", profile: "codex-chatgpt" },
        trustWorkspaceInstructions: true,
      }, { runner }),
    PaidEscalationDeclinedError,
  );
  assertEquals(runner.calls.length, 0);
});

Deno.test("allows an explicit Codex ChatGPT runner request when paid escalation is confirmed", async () => {
  const runner = recordingRunner();
  const result = await dispatch({
    runner: { kind: "acp", profile: "codex-chatgpt" },
    trustWorkspaceInstructions: true,
    confirmPaidEscalation: APPROVE,
  }, { runner });
  assertEquals(runner.calls.length, 1);
  assertObjectMatch(runner.calls[0], {
    runner: { kind: "acp", profile: "codex-chatgpt" },
  });
  assertEquals(result.text, "stubbed");
});

Deno.test("rejects an unapproved tier-2 ACP request with PaidEscalationDeclinedError", async () => {
  const runner = recordingRunner();
  await assertRejects(
    () =>
      dispatch({
        prompt: "test unapproved paid",
        routingOptions: { modelId: CODEX_TERRA.slug },
        trustWorkspaceInstructions: true,
      }, { models: [CODEX_TERRA], runner }),
    PaidEscalationDeclinedError,
  );
  assertEquals(runner.calls.length, 0);
});

Deno.test("allows a tier-2 ACP request when paid escalation is confirmed", async () => {
  const runner = recordingRunner();
  const result = await dispatch({
    prompt: "test approved paid",
    routingOptions: { modelId: CODEX_TERRA.slug },
    trustWorkspaceInstructions: true,
    confirmPaidEscalation: APPROVE,
  }, { models: [CODEX_TERRA], runner });
  assertEquals(runner.calls.length, 1);
  assertObjectMatch(runner.calls[0], {
    prompt: "test approved paid",
    runner: { kind: "acp", profile: "codex-chatgpt" },
  });
  assertEquals(result.text, "stubbed");
});

Deno.test("routes an ACP model selection to the external agent runner", async () => {
  const runner = recordingRunner();
  const result = await dispatch({
    prompt: "test acp dispatch",
    routingOptions: { modelId: "fixture" },
    trustWorkspaceInstructions: true,
  }, { models: [ACP_FIXTURE], runner });
  assertEquals(runner.calls.length, 1);
  assertObjectMatch(runner.calls[0], {
    prompt: "test acp dispatch",
    runner: { kind: "acp", profile: "fixture" },
  });
  assertEquals(result.receipt, "stubbed receipt: fixture");
});

Deno.test("allows resumed session turns on the external agent runner", async () => {
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
  assertEquals(second.sessionId, first.sessionId);
  assertEquals(runner.calls.map((call) => call.prompt), [
    "first turn",
    "second turn",
  ]);
  assertEquals(runner.calls[1].sessionId, first.sessionId);
});
