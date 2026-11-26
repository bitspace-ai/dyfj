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
 * Three rules hold whatever the profile says:
 *
 * - Only a loopback caller is eligible. The turn entry already forces the flag
 *   off for remote callers; this is the same backstop the context stage keeps,
 *   so a direct caller of the runtime core cannot elevate a remote turn.
 * - A workspace that cannot be resolved is not trusted. The profile must cover
 *   a canonical directory the runtime actually resolved, never a fallback it
 *   guessed or a path that is not there.
 * - The decision names the canonical workspace it was made for, so the runner
 *   that launches the turn can check the trust against the workspace it
 *   finally resolved rather than reusing a decision about a different path.
 */
import process from "node:process";
import { realpath, stat } from "node:fs/promises";
import type { WorkspaceConfigResolver } from "../config/mod.ts";
import {
  type WorkbenchAuthContext,
  workspaceRootForTransport,
} from "../contract/mod.ts";
import { fetchWorkbenchSessionWorkspaceRecord } from "../store/mod.ts";
import type {
  WorkbenchRuntimeInput,
  WorkbenchRuntimeServices,
} from "./runtime-types.ts";

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
 * session's row cannot be read, or when the path cannot be canonicalized as a
 * directory: the caller must not elevate on a guess.
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
  const selected = workspaceRootForTransport(requested, authContext.transport) ??
    input.rootOverride ?? process.cwd();
  try {
    const canonical = await realpath(selected);
    return (await stat(canonical)).isDirectory() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

/** The instruction-trust decision for one turn, and what it was made about. */
export interface WorkspaceTrustDecision {
  readonly trusted: boolean;
  /**
   * The canonical workspace the decision was made for. Undefined when the
   * workspace could not be resolved; `trusted` is false then, and a runner
   * must not elevate anything.
   */
  readonly workspace: string | undefined;
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
): Promise<WorkspaceTrustDecision> {
  const authContext = input.authContext ?? LOCAL_AUTH_CONTEXT;
  if (authContext.transport !== "loopback") {
    return { trusted: false, workspace: undefined };
  }
  const resolver: WorkspaceConfigResolver | undefined =
    services.workspaceConfig;
  const workspace = await workspaceForTrust(input, authContext, services);
  if (workspace === undefined) return { trusted: false, workspace: undefined };
  if (resolver === undefined) {
    return {
      trusted: input.trustWorkspaceInstructions === true,
      workspace,
    };
  }
  return {
    trusted: resolver.resolve(workspace).trustInstructions === true,
    workspace,
  };
}
