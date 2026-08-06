import { fileURLToPath } from "node:url";
import {
  type AcpExecutionProfile,
  type AcpPermissionVerdict,
  assertAcpPromptWithinLimit,
  runAcpAgent,
} from "./acp-client";
import {
  type ExternalAgentWorkbenchRuntimeResult,
  type WorkbenchAuthContext,
  type WorkbenchRuntimeEvent,
  type WorkbenchRuntimeInput,
  workspaceRootForTransport,
} from "./workbench";
import {
  buildWorkbenchSessionContent,
  buildWorkbenchSessionSlug,
  createWorkbenchSession,
  fetchWorkbenchSessionWorkspaceRecord,
  updateWorkbenchSession,
} from "./sessions";
import {
  generateSpanId,
  generateTraceId,
  generateULID,
  writeEvent,
} from "./utils";
import { DomainError, sanitizeBoundaryText } from "./turn-contract";

export function fixtureProfile(workspace: string): AcpExecutionProfile {
  const home = Deno.env.get("HOME");
  const environment: Record<string, string> = {};
  if (home !== undefined) {
    environment.HOME = home;
  }
  return {
    slug: "fixture",
    command: Deno.execPath(),
    args: [
      "run",
      "--cached-only",
      "--node-modules-dir=manual",
      `--config=${fileURLToPath(new URL("../deno.json", import.meta.url))}`,
      "--allow-env=ACP_FIXTURE_MODE,ACP_FIXTURE_ALLOWED,ACP_FIXTURE_AMBIENT_VALUE,ANTHROPIC_API_KEY,DOLT_PASSWORD,DYFJ_MEMORY_MCP_TOKEN,SSH_AUTH_SOCK",
      fileURLToPath(
        new URL("../scripts/acp-fixture-agent.ts", import.meta.url),
      ),
    ],
    environment,
    workspace,
    transport: "local_stdio",
    accessRoute: "local_sidecar",
    costBasis: "local_free",
  };
}

async function resolveWorkspace(
  input: WorkbenchRuntimeInput,
  authContext: WorkbenchAuthContext,
): Promise<string> {
  let requested = input.workspaceRoot;
  if (input.sessionId !== undefined) {
    const stored = await fetchWorkbenchSessionWorkspaceRecord({
      sessionId: input.sessionId,
    });
    if (!stored.exists) {
      throw new DomainError("Workbench session not found");
    }
    if (stored.workspace === null) {
      throw new DomainError("Workbench session has no persisted workspace");
    }
    requested = stored.workspace;
  }
  const selected = workspaceRootForTransport(
    requested,
    authContext.transport,
  ) ?? input.rootOverride ?? Deno.cwd();
  try {
    const resolved = await Deno.realPath(selected);
    if ((await Deno.stat(resolved)).isDirectory) return resolved;
  } catch {
    // The fixed error below must not disclose the selected host path.
  }
  throw new DomainError("External-agent workspace is not a directory");
}

function receiptText(input: {
  sessionId: string;
  traceId: string;
  profile: AcpExecutionProfile;
  workspaceEvidence: string;
  result: Awaited<ReturnType<typeof runAcpAgent>>;
  sessionProjectionSkipped?: boolean;
}): string {
  return [
    "External-agent turn receipt",
    `Session: ${input.sessionId}`,
    `Trace: ${input.traceId}`,
    `Runner: ${input.profile.slug} over ACP ${
      input.result.protocolVersion === undefined
        ? "(not negotiated)"
        : `v${input.result.protocolVersion}`
    }`,
    `ACP stop reason: ${input.result.acpStopReason ?? "not reported"}`,
    `External session: ${input.result.externalSessionId ?? "not created"}`,
    `Workspace: ${input.workspaceEvidence}`,
    `Transport: ${input.profile.transport}`,
    `Access route: ${input.profile.accessRoute}`,
    `Cost basis: ${input.profile.costBasis}`,
    `Outcome: ${input.result.stopReason}`,
    `Elapsed: ${input.result.elapsedMs} ms`,
    ...(input.sessionProjectionSkipped
      ? ["Session projection: update skipped"]
      : []),
    "Evidence: Workbench observed the ACP exchange; the agent's inner state is opaque.",
  ].join("\n");
}

async function emitRuntimeEvent(
  handler: WorkbenchRuntimeInput["onRuntimeEvent"],
  event: WorkbenchRuntimeEvent,
): Promise<void> {
  if (handler === undefined) return;
  try {
    await handler(event);
  } catch {
    console.warn("Runtime event delivery skipped");
  }
}

export async function runExternalAgentWorkbenchRuntime(
  input: WorkbenchRuntimeInput & {
    runner: { kind: "acp"; profile: "fixture" };
  },
): Promise<ExternalAgentWorkbenchRuntimeResult> {
  let cancellationClosed = false;
  const closeCancellation = () => {
    if (cancellationClosed) return;
    cancellationClosed = true;
    try {
      input.onCancellationClosed?.();
    } catch {
      // Cancellation registration cleanup is non-authoritative.
    }
  };
  const authContext = input.authContext ?? {
    transport: "loopback",
    authnStatus: "authenticated",
    authnMechanism: "local_user",
    authnIssuerRef: "local_os",
    authzBasis: "user_consent",
  } satisfies WorkbenchAuthContext;
  let workspace: string;
  let profile: AcpExecutionProfile;
  try {
    if (authContext.transport !== "loopback") {
      throw new DomainError(
        "External local agents are unavailable to remote callers",
      );
    }
    assertAcpPromptWithinLimit(input.prompt);
    workspace = await resolveWorkspace(input, authContext);
    profile = fixtureProfile(workspace);
  } catch (error) {
    closeCancellation();
    throw error;
  }

  const sessionId = input.sessionId ?? generateULID();
  const traceId = generateTraceId();
  const rootSpanId = generateSpanId();
  const principalId = input.principalId ?? "user";
  const workspaceEvidence = sanitizeBoundaryText(workspace, 1_024);
  const startedAt = Date.now();
  const authnFields = {
    authn_status: authContext.authnStatus,
    authn_mechanism: authContext.authnMechanism,
    authn_issuer_ref: authContext.authnIssuerRef,
  };
  let sessionStartWritten = false;
  let sessionCreated = false;
  const writePermissionVerdict = async (
    verdict: AcpPermissionVerdict,
    signal: AbortSignal,
  ) => {
    await writeEvent({
      event_id: generateULID(),
      session_id: sessionId,
      event_type: "agent_permission",
      trace_id: traceId,
      span_id: generateSpanId(),
      parent_span_id: rootSpanId,
      principal_id: verdict.source === "operator"
        ? principalId
        : "dyfj-workbench",
      principal_type: verdict.source === "operator" ? "human" : "service",
      action: verdict.source === "operator" ? "decide" : "enforce",
      resource: verdict.toolCallId,
      authz_basis: authContext.authzBasis,
      ...authnFields,
      permission_verdict: verdict.decision === "approve"
        ? "approved"
        : verdict.decision === "deny"
        ? "denied"
        : "cancelled",
      runner_kind: "external_agent",
      runner_profile: profile.slug,
      runner_protocol: "acp",
    }, { signal });
  };

  try {
    await emitRuntimeEvent(input.onRuntimeEvent, {
      type: "sessionStart",
      sessionId,
      traceId,
      mode: input.mode,
    });
    await emitRuntimeEvent(input.onRuntimeEvent, {
      type: "inputReceived",
      sessionId,
      promptLength: input.prompt.length,
    });
    await writeEvent({
      event_id: generateULID(),
      session_id: sessionId,
      event_type: "session_start",
      trace_id: traceId,
      span_id: rootSpanId,
      principal_id: principalId,
      principal_type: "human",
      action: "start",
      resource: "workbench_session",
      authz_basis: authContext.authzBasis,
      ...authnFields,
      content: input.prompt,
    });
    sessionStartWritten = true;
    if (input.sessionId === undefined) {
      await createWorkbenchSession({
        sessionId,
        slug: buildWorkbenchSessionSlug(sessionId),
        taskDescription: input.prompt,
        content: buildWorkbenchSessionContent({
          mode: input.mode,
          prompt: input.prompt,
          traceId,
          contextSources: [],
        }),
        workspace,
      });
      sessionCreated = true;
    }

    await writeEvent({
      event_id: generateULID(),
      session_id: sessionId,
      event_type: "runner_selected",
      trace_id: traceId,
      span_id: generateSpanId(),
      parent_span_id: rootSpanId,
      principal_id: principalId,
      principal_type: "agent",
      action: "select",
      resource: profile.slug,
      authz_basis: authContext.authzBasis,
      ...authnFields,
      runner_kind: "external_agent",
      runner_profile: profile.slug,
      runner_protocol: "acp",
      runner_transport: profile.transport,
      runner_access_route: profile.accessRoute,
      runner_cost_basis: profile.costBasis,
      runner_workspace: workspaceEvidence,
      runner_evidence_scope: "outer_only",
    });
    const result = await runAcpAgent({
      profile,
      prompt: input.prompt,
      abortSignal: input.abortSignal,
      onTextDelta: input.onTextDelta,
      confirmPermission: input.confirmExternalAgentPermission,
      onPermissionVerdict: writePermissionVerdict,
    });
    closeCancellation();
    let receipt = receiptText({
      sessionId,
      traceId,
      profile,
      workspaceEvidence,
      result,
    });
    await writeEvent({
      event_id: generateULID(),
      session_id: sessionId,
      event_type: "agent_response",
      trace_id: traceId,
      span_id: generateSpanId(),
      parent_span_id: rootSpanId,
      principal_id: principalId,
      principal_type: "agent",
      action: "respond",
      resource: profile.slug,
      authz_basis: authContext.authzBasis,
      ...authnFields,
      content: result.text,
      stop_reason: result.stopReason,
      duration_ms: result.elapsedMs,
      runner_kind: "external_agent",
      runner_profile: profile.slug,
      runner_protocol: "acp",
      runner_protocol_version: result.protocolVersion === undefined
        ? null
        : String(result.protocolVersion),
      runner_stop_reason: result.acpStopReason ?? null,
      runner_external_session_id: result.externalSessionId ?? null,
      runner_agent_name: result.agentName ?? null,
      runner_agent_version: result.agentVersion ?? null,
      runner_transport: profile.transport,
      runner_access_route: profile.accessRoute,
      runner_cost_basis: profile.costBasis,
      runner_workspace: workspaceEvidence,
      runner_capabilities: JSON.stringify(result.capabilities),
      runner_evidence_scope: "outer_only",
    });
    await writeEvent({
      event_id: generateULID(),
      session_id: sessionId,
      event_type: "session_end",
      trace_id: traceId,
      span_id: generateSpanId(),
      parent_span_id: rootSpanId,
      principal_id: principalId,
      principal_type: "human",
      action: "end",
      resource: "workbench_session",
      authz_basis: authContext.authzBasis,
      ...authnFields,
      duration_ms: Date.now() - startedAt,
    });
    try {
      await updateWorkbenchSession({
        sessionId,
        content: buildWorkbenchSessionContent({
          mode: input.mode,
          prompt: input.prompt,
          traceId,
          contextSources: [],
          receipt,
        }),
      });
    } catch {
      console.warn("Session projection update skipped");
      receipt = receiptText({
        sessionId,
        traceId,
        profile,
        workspaceEvidence,
        result,
        sessionProjectionSkipped: true,
      });
    }
    await emitRuntimeEvent(
      input.onRuntimeEvent,
      result.stopReason === "aborted"
        ? {
          type: "turnAborted",
          sessionId,
          traceId,
          turnId: input.turnId,
        }
        : result.stopReason === "error"
        ? {
          type: "turnFailed",
          sessionId,
          traceId,
          errorMessage: "External agent declined the turn",
        }
        : {
          type: "turnCompleted",
          sessionId,
          traceId,
        },
    );
    return {
      sessionId,
      traceId,
      stopReason: result.stopReason,
      text: result.text,
      receipt,
      runner: {
        kind: "external_agent",
        profile: profile.slug,
        protocol: "acp",
        protocolVersion: result.protocolVersion,
        externalStopReason: result.acpStopReason,
        externalSessionId: result.externalSessionId,
        agentName: result.agentName,
        agentVersion: result.agentVersion,
        capabilities: result.capabilities,
        workspace,
        transport: profile.transport,
        accessRoute: profile.accessRoute,
        costBasis: profile.costBasis,
        evidence: { source: "acp", innerState: "opaque" },
        elapsedMs: result.elapsedMs,
      },
      route: { reason: "explicit_external_agent" },
      context: { sources: [] },
    };
  } catch (error) {
    try {
      closeCancellation();
    } catch {
      // Preserve the turn failure while still attempting durable finalization.
    }
    if (sessionStartWritten) {
      try {
        await writeEvent({
          event_id: generateULID(),
          session_id: sessionId,
          event_type: "error",
          trace_id: traceId,
          span_id: generateSpanId(),
          parent_span_id: rootSpanId,
          principal_id: principalId,
          principal_type: "agent",
          action: "invoke",
          resource: profile.slug,
          authz_basis: authContext.authzBasis,
          ...authnFields,
          stop_reason: "error",
          duration_ms: Date.now() - startedAt,
          runner_kind: "external_agent",
          runner_profile: profile.slug,
          runner_protocol: "acp",
        });
      } catch {
        // The originating failure remains authoritative.
      }
      try {
        await writeEvent({
          event_id: generateULID(),
          session_id: sessionId,
          event_type: "session_end",
          trace_id: traceId,
          span_id: generateSpanId(),
          parent_span_id: rootSpanId,
          principal_id: principalId,
          principal_type: "human",
          action: "end",
          resource: "workbench_session",
          authz_basis: authContext.authzBasis,
          ...authnFields,
          duration_ms: Date.now() - startedAt,
        });
      } catch {
        // Continue to the client-visible failure notification.
      }
    }
    if (sessionCreated) {
      try {
        await updateWorkbenchSession({
          sessionId,
          content: buildWorkbenchSessionContent({
            mode: input.mode,
            prompt: input.prompt,
            traceId,
            contextSources: [],
            receipt: "External-agent turn failed",
          }),
        });
      } catch {
        console.warn("Failed session projection update skipped");
      }
    }
    await emitRuntimeEvent(input.onRuntimeEvent, {
      type: "turnFailed",
      sessionId,
      traceId,
      errorMessage: "External agent turn failed",
    });
    throw error;
  }
}
