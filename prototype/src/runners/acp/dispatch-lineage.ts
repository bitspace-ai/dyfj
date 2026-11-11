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
  sessionStartEvent,
  type Store,
} from "../../store/mod.ts";
import { DISPATCH_CHILD_CONTEXT_LINE } from "../../tools/mod.ts";

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
