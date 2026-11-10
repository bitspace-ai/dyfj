/**
 * The roots an ACP session is created with: the profile's workspace as the
 * session's cwd, and its additional directories (`--add-dir` roots that are
 * read-write) as the session's `additionalDirectories`.
 */

import { isAbsolute, win32 } from "node:path";
import process from "node:process";
import { AcpRunnerError } from "./acp-errors.ts";

/** The profile fields that name the session's roots. */
export interface AcpSessionRoots {
  workspace: string;
  additionalDirectories?: readonly string[];
}

function absolute(path: string): boolean {
  return isAbsolute(path) ||
    (process.platform === "win32" && win32.isAbsolute(path));
}

/** Refuse a relative workspace or additional directory before spawning. */
export function assertAbsoluteSessionRoots(roots: AcpSessionRoots): void {
  if (!absolute(roots.workspace)) {
    throw new AcpRunnerError("ACP workspace must be absolute", "session");
  }
  if (!(roots.additionalDirectories ?? []).every(absolute)) {
    throw new AcpRunnerError(
      "ACP additional directories must be absolute",
      "session",
    );
  }
}

interface SessionBuilderLike<Started> {
  withAdditionalDirectories(directories: string[]): SessionBuilderLike<Started>;
  start(): Started;
}

/**
 * The `session/new` builder for `roots`. With additional directories it
 * refuses an agent that does not advertise
 * `sessionCapabilities.additionalDirectories`, rather than starting a
 * session that would ignore them.
 */
export function acpSessionBuilder<Started>(
  context: { buildSession(cwd: string): SessionBuilderLike<Started> },
  roots: AcpSessionRoots,
  initialized: {
    agentCapabilities?: {
      sessionCapabilities?: { additionalDirectories?: unknown } | null;
    } | null;
  },
): SessionBuilderLike<Started> {
  const builder = context.buildSession(roots.workspace);
  const directories = roots.additionalDirectories ?? [];
  if (directories.length === 0) return builder;
  if (!initialized.agentCapabilities?.sessionCapabilities?.additionalDirectories) {
    throw new AcpRunnerError(
      "ACP agent does not support additional directories",
      "session",
    );
  }
  return builder.withAdditionalDirectories([...directories]);
}
