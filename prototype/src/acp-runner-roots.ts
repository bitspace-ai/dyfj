/**
 * The roots an external-agent turn runs with: its workspace, resolved from
 * the request or the session row, and the extra roots (`--add-dir`) the
 * runtime admits beside it.
 *
 * Only read-write roots reach the runner, as the session's
 * `additionalDirectories` and, for Codex, as `sandbox_workspace_write`
 * writable roots in `CODEX_CONFIG`. A read-only root is admitted, so a
 * protected path is still refused, but not sent: the runner would make it
 * writable.
 */

import { realpath, stat } from "node:fs/promises";
import process from "node:process";
import { ownPrototypeRoot } from "./acp-adapter-package.ts";
import type { AcpExecutionProfile } from "./acp-client.ts";
import { processEnv } from "./config/mod.ts";
import {
  additionalRootsForTransport,
  DomainError,
  type WorkbenchAuthContext,
  type WorkbenchRuntimeRequest,
  workspaceRootForTransport,
} from "./contract/mod.ts";
import {
  fetchWorkbenchSessionWorkspaceRecord,
  type SessionReader,
} from "./store/mod.ts";
import { admitAdditionalRoots, protectedPaths } from "./tools/mod.ts";

type RootRequest = Pick<
  WorkbenchRuntimeRequest,
  "workspaceRoot" | "sessionId" | "rootOverride" | "additionalRoots"
>;

/** The turn's workspace: the session row's on resume, else the request's. */
export async function resolveRunnerWorkspace(
  input: RootRequest,
  authContext: WorkbenchAuthContext,
  sessions: SessionReader,
): Promise<string> {
  let requested = input.workspaceRoot;
  if (input.sessionId !== undefined) {
    const stored = await fetchWorkbenchSessionWorkspaceRecord({
      sessionId: input.sessionId,
      sessions,
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
  ) ?? input.rootOverride ?? process.cwd();
  try {
    const resolved = await realpath(selected);
    if ((await stat(resolved)).isDirectory()) return resolved;
  } catch {
    // The fixed error below must not disclose the selected host path.
  }
  throw new DomainError("External-agent workspace is not a directory");
}

/** `CODEX_CONFIG` with `roots` added to its workspace-write writable roots. */
function withCodexWritableRoots(
  environment: Record<string, string>,
  roots: readonly string[],
): Record<string, string> {
  if (environment.CODEX_CONFIG === undefined) return environment;
  const config = JSON.parse(environment.CODEX_CONFIG) as Record<string, unknown>;
  const sandbox = (config.sandbox_workspace_write ?? {}) as {
    writable_roots?: string[];
  };
  config.sandbox_workspace_write = {
    ...sandbox,
    writable_roots: [...(sandbox.writable_roots ?? []), ...roots],
  };
  return { ...environment, CODEX_CONFIG: JSON.stringify(config) };
}

/**
 * `profile` with the turn's admitted read-write roots. Throws
 * `AdditionalRootRefusedError` for a refused root. A non-loopback caller's
 * roots are ignored, as its workspace is.
 */
export async function withAddedRoots(
  input: RootRequest,
  authContext: WorkbenchAuthContext,
  profile: AcpExecutionProfile,
): Promise<AcpExecutionProfile> {
  const requested = additionalRootsForTransport(
    input.additionalRoots,
    authContext.transport,
  );
  if (requested.length === 0) return profile;
  const admitted = await admitAdditionalRoots(requested, {
    primary: profile.workspace,
    protectedPaths: await protectedPaths({
      home: processEnv.get("HOME"),
      dyfjRoot: processEnv.get("DYFJ_ROOT"),
      prototypeRoot: ownPrototypeRoot(),
    }),
  });
  const writable = admitted.filter((root) => !root.readOnly).map((root) =>
    root.path
  );
  if (writable.length === 0) return profile;
  return {
    ...profile,
    additionalDirectories: writable,
    environment: withCodexWritableRoots(profile.environment, writable),
  };
}
