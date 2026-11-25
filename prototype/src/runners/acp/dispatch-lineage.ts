/**
 * Session-open lineage recording and child prompt framing for external-agent
 * turns (BIT-907).
 */
import type {
  DispatchRecord,
  WorkbenchAuthContext,
  WorkbenchRuntimeRequest,
} from "../../contract/mod.ts";
import { generateULID } from "../../kernel/mod.ts";
import {
  buildWorkbenchSessionContent,
  buildWorkbenchSessionSlug,
  createWorkbenchSession,
  type EventInsert,
  fetchWorkbenchSessionLineage,
  resolveWorkbenchDispatchDepth,
  sessionStartEvent,
  type Store,
} from "../../store/mod.ts";
import type { WorkspaceConfigResolver } from "../../config/mod.ts";
import { gateSectionFor } from "../../config/mod.ts";
import { DISPATCH_CHILD_CONTEXT_LINE, type DispatchSessionFactory, type ToolCatalogPorts } from "../../tools/mod.ts";
import {
  bindCodexTurn,
  type CodexTurnTools,
  type ExternalAgentToolBridge,
} from "../../workbench-tool-bridge.ts";

/**
 * Bind coordinator tools using runtime-owned session identity and persisted
 * depth, and the sections that apply to this turn's workspace (BIT-982): the
 * runtime owns one gate-run registry and one dispatch service for its
 * lifetime, and which of their commands this turn may reach is decided per
 * workspace here, exactly as the native route decides it
 * (`engine/build-context.ts`). Without that, a profile-only gate carried a
 * null boot config and vanished on Codex turns, and a boot dispatch config
 * kept its global roots even where a profile narrowed them.
 */
export async function bindExternalAgentTools(
  input: CodexTurnTools & { sessionId?: string; dispatchRecord?: DispatchRecord },
  dependencies: {
    gate?: import("../../tools/mod.ts").GateRuntimePorts;
    store: Store;
    dispatch?: DispatchSessionFactory;
    toolBridge?: ExternalAgentToolBridge;
    /** The profile resolver; absent, the boot-time sections apply. */
    workspaceConfig?: WorkspaceConfigResolver;
  } & Pick<ToolCatalogPorts, "env" | "dialExecutor" | "sandbox">,
  context: Omit<Parameters<DispatchSessionFactory["forSession"]>[0], "depth">,
) {
  // What this workspace is entitled to. An absent resolver keeps the boot-time
  // global section, which is what a runtime configured without `[[workspaces]]`
  // has always done.
  const resolved = dependencies.workspaceConfig === undefined ||
      input.workspaceRoot === undefined
    ? undefined
    : dependencies.workspaceConfig.resolve(input.workspaceRoot);
  const gate = dependencies.gate === undefined ? undefined : {
    ...dependencies.gate,
    config: gateSectionFor(resolved, dependencies.gate.config),
  };
  let dispatch;
  if (context.authContext.transport === "loopback" &&
      input.runner.profile === "codex-chatgpt" && dependencies.toolBridge !== undefined &&
      dependencies.dispatch !== undefined) {
    const depth = await resolveWorkbenchDispatchDepth({
      dispatchRecord: input.dispatchRecord,
      resumingSession: input.sessionId !== undefined,
      sessionId: context.parentSessionId,
      events: dependencies.store.events,
    });
    // A workspace whose profile declares no dispatch section starts no
    // children, whatever the boot-time `[dispatch]` says.
    const dispatchConfig = resolved === undefined ? undefined : resolved.dispatch;
    if (depth === 0 && dispatchConfig !== null) {
      dispatch = dependencies.dispatch.forSession({
        ...context,
        depth,
        ...(dispatchConfig === undefined ? {} : { config: dispatchConfig }),
      });
    }
  }
  return await bindCodexTurn(
    dependencies.toolBridge,
    context.parentSessionId,
    { ...input, dispatch },
    { ...dependencies, ...(gate === undefined ? {} : { gate }) },
  );
}


export function prependChildContextLine(
  prompt: string,
  isDispatchedChild: boolean,
): string {
  return isDispatchedChild
    ? `${DISPATCH_CHILD_CONTEXT_LINE}\n\n${prompt}`
    : prompt;
}

export async function openExternalAgentSession(input: {
  store: Store;
  sessionId: string;
  isNewSession: boolean;
  traceId: string;
  rootSpanId: string;
  principalId: string;
  authContext: WorkbenchAuthContext;
  mode: WorkbenchRuntimeRequest["mode"];
  prompt: string;
  workspace: string;
  dispatchRecord?: DispatchRecord;
  onSessionStartWritten?: () => void;
  onSessionRecorded?: (sessionId: string) => void | Promise<void>;
  writeEvent: (event: EventInsert) => Promise<void>;
}): Promise<{ isDispatchedChild: boolean; sessionCreated: boolean }> {
  const dispatchRecord = input.isNewSession ? input.dispatchRecord : undefined;
  const isDispatchedChild = dispatchRecord !== undefined
    ? true
    : !input.isNewSession
    ? ((await fetchWorkbenchSessionLineage({
      sessionId: input.sessionId,
      events: input.store.events,
    })).depth ?? 0) >= 1
    : false;

  await input.writeEvent(sessionStartEvent({
    event_id: generateULID(),
    session_id: input.sessionId,
    trace_id: input.traceId,
    span_id: input.rootSpanId,
    principal_id: input.principalId,
    principal_type: "human",
    action: "start",
    resource: "workbench_session",
    authz_basis: input.authContext.authzBasis,
    authn_status: input.authContext.authnStatus,
    authn_mechanism: input.authContext.authnMechanism,
    authn_issuer_ref: input.authContext.authnIssuerRef,
    ...(dispatchRecord === undefined
      ? {}
      : {
        parent_session_id: dispatchRecord.parentSessionId,
        lineage_depth: dispatchRecord.depth,
        lineage_label: dispatchRecord.label,
        model_id: dispatchRecord.model,
        reasoning_effort: dispatchRecord.effort,
        turn_route: dispatchRecord.route,
        model_family: dispatchRecord.family,
        tool_arguments: JSON.stringify(dispatchRecord),
      }),
    content: input.prompt,
  }));
  input.onSessionStartWritten?.();

  let sessionCreated = false;
  if (input.isNewSession) {
    await createWorkbenchSession({
      journal: input.store.journal,
      sessionId: input.sessionId,
      slug: buildWorkbenchSessionSlug(input.sessionId),
      taskDescription: input.prompt,
      content: buildWorkbenchSessionContent({
        mode: input.mode,
        prompt: input.prompt,
        traceId: input.traceId,
        contextSources: [],
      }),
      workspace: input.workspace,
    });
    sessionCreated = true;
  }

  await input.onSessionRecorded?.(input.sessionId);
  return { isDispatchedChild, sessionCreated };
}
