import { systemClock } from "../kernel/mod.ts";
import {
  type AcpRunnerSelection,
  DomainError,
  type ExternalAgentWorkbenchRuntimeResult,
} from "../contract/mod.ts";
import { processEnv } from "../config/mod.ts";
import { createCommandRegistry } from "../tools/mod.ts";
import type { ObservedCallContext } from "./observed-call.ts";
import { resolveRoute } from "./route.ts";
import type {
  ExternalAgentRunner,
  NativeWorkbenchRuntimeResult,
  WorkbenchRuntimeInput,
  WorkbenchRuntimeResult,
  WorkbenchRuntimeServices,
} from "./runtime-types.ts";
import { openSession, recordNewSession } from "./open-session.ts";
import { buildContext } from "./build-context.ts";
import {
  commitEvent,
  type NativeTurnPorts,
  newTurnState,
} from "./turn-state.ts";
import { budgetGate } from "./budget-gate.ts";
import type { RoutedTurn } from "./routed-turn.ts";
import { loadTranscript } from "./load-transcript.ts";
import { agentLoop } from "./agent-loop.ts";
import { completeTurn, failTurn, finalize } from "./finalize.ts";

function requireExternalAgentRunner(
  services: WorkbenchRuntimeServices | undefined,
): ExternalAgentRunner {
  const runner = services?.externalAgentRunner;
  if (runner === undefined) {
    throw new DomainError("No external-agent runner is configured");
  }
  return runner;
}

export function runWorkbenchRuntime(
  runtimeInput: WorkbenchRuntimeInput & { runner: AcpRunnerSelection },
  services: WorkbenchRuntimeServices & {
    externalAgentRunner: ExternalAgentRunner;
  },
): Promise<ExternalAgentWorkbenchRuntimeResult>;
export function runWorkbenchRuntime(
  runtimeInput: WorkbenchRuntimeInput & { runner?: undefined },
  services: WorkbenchRuntimeServices,
): Promise<NativeWorkbenchRuntimeResult>;
export function runWorkbenchRuntime(
  runtimeInput: WorkbenchRuntimeInput,
  services: WorkbenchRuntimeServices,
): Promise<WorkbenchRuntimeResult>;
export async function runWorkbenchRuntime(
  runtimeInput: WorkbenchRuntimeInput,
  services: WorkbenchRuntimeServices,
): Promise<WorkbenchRuntimeResult> {
  const route = await resolveRoute(runtimeInput, services.store.models);
  if (route.runner === "acp") {
    return await requireExternalAgentRunner(services).run({
      ...runtimeInput,
      routingOptions: route.routingOptions,
      runner: route.selection,
    });
  }

  return await runNativeWorkbenchRuntime(runtimeInput, {
    store: services.store,
    budgetScopes: services.budgetScopes,
    clock: services.clock ?? systemClock,
    env: services.env ?? processEnv,
    providerIo: {
      ...(services.http === undefined ? {} : { fetchFn: services.http }),
      ...(services.env === undefined
        ? {}
        : { getEnv: (name: string) => services.env?.get(name) }),
    },
  });
}

async function runNativeWorkbenchRuntime(
  runtimeInput: WorkbenchRuntimeInput,
  ports: NativeTurnPorts,
): Promise<NativeWorkbenchRuntimeResult> {
  const session = await openSession(runtimeInput, ports);
  const state = newTurnState(session, createCommandRegistry());
  // Shared by every provider call this turn makes (agent loop and
  // compression): observedProviderCall writes each call's provider_call event
  // under the turn root span and records its usage with this turn's tracker.
  const observed: ObservedCallContext = {
    writeEvent: (event) => commitEvent(ports.store, event),
    budget: session.budget,
    clock: ports.clock,
    sessionId: session.sessionId,
    traceId: session.traceId,
    principalId: session.principalId,
    turnRootSpanId: session.turnRootSpanId,
    authnEventFields: session.authnEventFields,
    onSkippedEventWrite: state.audit.noteSkippedEventWrite,
  };

  try {
    await buildContext(state, runtimeInput, ports);
    await recordNewSession(state, ports);
    const route = await budgetGate(state, runtimeInput, ports);
    const routed: RoutedTurn = {
      state,
      input: runtimeInput,
      ports,
      route,
      observed,
    };
    session.log(
      `Model:  ${route.selected.displayName} (tier ${route.selected.tier})`,
    );
    session.log(`Route:  ${state.routingReason}\n`);
    const messages = await loadTranscript(routed);
    const outcome = await agentLoop(routed, messages);
    await completeTurn(state, runtimeInput, ports, outcome);
  } catch (err: unknown) {
    // An error raised while reporting the failure is dropped, as it always
    // has been: finalize still closes the session and surfaces the turn's
    // own error or a failed integrity write.
    await failTurn(state, runtimeInput, ports, err).catch(() => {});
  }
  return await finalize(state, ports);
}
