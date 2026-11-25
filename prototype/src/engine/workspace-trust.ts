/**
 * The workspace instruction trust that applies to a turn before its route is
 * chosen (BIT-982).
 *
 * Route resolution decides whether a Codex ChatGPT turn may start, and it runs
 * before any session or context exists. It therefore has to answer the same
 * question the native context stage answers later, from the same source: the
 * operator's `[[workspaces]]` profile that covers the turn's workspace, else
 * the operator's standing global setting. Reading only the global setting let a
 * profile's decision be bypassed on the ACP route in both directions - a
 * globally trusted runtime launched a workspace whose profile declined, and a
 * globally untrusted one refused a workspace whose profile trusted it.
 *
 * Two rules hold whatever the profile says:
 *
 * - Only a loopback caller is eligible. The turn entry already forces the flag
 *   off for remote callers; this is the same backstop the context stage keeps,
 *   so a direct caller of the runtime core cannot elevate a remote turn.
 * - A workspace that cannot be resolved is not trusted. The profile must cover
 *   a root the runtime actually resolved, never a fallback it guessed.
 */
import process from "node:process";
import type { WorkspaceConfigResolver } from "../config/mod.ts";
import {
  type WorkbenchAuthContext,
  workspaceRootForTransport,
} from "../contract/mod.ts";
import { fetchWorkbenchSessionWorkspaceRecord } from "../store/mod.ts";
import type { WorkbenchRuntimeInput, WorkbenchRuntimeServices } from "./runtime-types.ts";

const LOCAL_AUTH_CONTEXT: WorkbenchAuthContext = {
  transport: "loopback",
  authnStatus: "authenticated",
  authnMechanism: "local_user",
  authnIssuerRef: "local_os",
  authzBasis: "user_consent",
};

/**
 * The workspace the turn runs in, resolved the way the external-agent runner
 * resolves it: the session row's on resume, else the request's, gated by
 * transport, else the runtime's default root. Undefined when a resumed
 * session's row cannot be read: the caller must not elevate on a guess.
 */
async function workspaceForTrust(
  input: WorkbenchRuntimeInput,
  authContext: WorkbenchAuthContext,
  services: WorkbenchRuntimeServices,
): Promise<string | undefined> {
  let requested = input.workspaceRoot;
  if (input.sessionId !== undefined) {
    try {
      const stored = await fetchWorkbenchSessionWorkspaceRecord({
        sessionId: input.sessionId,
        sessions: services.store.sessions,
      });
      requested = stored.workspace ?? undefined;
    } catch {
      return undefined;
    }
  }
  return workspaceRootForTransport(requested, authContext.transport) ??
    input.rootOverride ?? process.cwd();
}

/**
 * Whether this turn's workspace instructions are elevated: the profile that
 * covers the resolved workspace when there is one, else the operator's global
 * setting. False for every non-loopback caller and for an unresolved
 * workspace.
 */
export async function resolveWorkspaceTrust(
  input: WorkbenchRuntimeInput,
  services: WorkbenchRuntimeServices,
): Promise<boolean> {
  const authContext = input.authContext ?? LOCAL_AUTH_CONTEXT;
  if (authContext.transport !== "loopback") return false;
  const resolver: WorkspaceConfigResolver | undefined =
    services.workspaceConfig;
  if (resolver === undefined) return input.trustWorkspaceInstructions === true;
  const workspace = await workspaceForTrust(input, authContext, services);
  if (workspace === undefined) return false;
  return resolver.resolve(workspace).trustInstructions === true;
}
