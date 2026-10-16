/**
 * Spawn enforcement at the product's own seams: every child process the
 * runtime and the CLI start goes through `guardedSpawn`, which refuses a
 * binary outside the `RuntimePolicy`'s run list (`runtime-policy.ts`) before
 * any process starts.
 *
 * A command is allowed, as the runtime's run permission flag allows it, when
 * either:
 * - it equals a run entry exactly (an absolute path, or a bare name such as
 *   `git`); or
 * - it is the same file as a run entry once both are resolved: an absolute
 *   path through `realpath`, a bare name through the first executable match on
 *   PATH and then `realpath`. PATH is the spawn's own `env.PATH` when the
 *   caller passes an env, else the process's PATH, which is also what the
 *   child-process API searches.
 *
 * A relative path that contains a separator (`./tool`) is refused: its target
 * depends on the working directory, so the guard cannot decide it.
 */

import { spawn } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import process from "node:process";
import type { RuntimePolicy } from "./runtime-policy.ts";

const RUN_POLICY_HINT = "The runtime may start only its built-in tools, " +
  "the Node executable named by DYFJ_NODE_PATH and the resolver named by " +
  "[secrets].command in ~/.dyfj/config.toml.";

/** A spawn the runtime's run policy does not allow. */
export class SpawnRefusedError extends Error {
  /** The refused command, as the caller named it. */
  readonly command: string;

  constructor(command: string) {
    super(
      `spawn of "${printable(command)}" refused: the binary is not in the ` +
        `runtime's run policy. ${RUN_POLICY_HINT}`,
    );
    this.name = "SpawnRefusedError";
    this.command = command;
  }
}

function printable(command: string): string {
  // deno-lint-ignore no-control-regex
  const visible = command.replace(/[\u0000-\u001f\u007f]/g, "?");
  return visible.length > 256 ? `${visible.slice(0, 256)}…` : visible;
}

function isBareName(command: string): boolean {
  return !command.includes("/") && !command.includes("\\");
}

function executableFile(path: string): string | null {
  try {
    const resolved = realpathSync(path);
    if (!statSync(resolved).isFile()) return null;
    if (process.platform !== "win32") accessSync(resolved, constants.X_OK);
    return resolved;
  } catch {
    return null;
  }
}

/** The file `command` names, resolved as the guard documents, or null. */
function resolveCommand(command: string, pathValue: string | undefined) {
  if (isAbsolute(command)) return executableFile(command);
  if (!isBareName(command) || pathValue === undefined) return null;
  for (const dir of pathValue.split(delimiter)) {
    if (dir === "" || !isAbsolute(dir)) continue;
    const found = executableFile(join(dir, command));
    if (found !== null) return found;
  }
  return null;
}

/** Throw `SpawnRefusedError` unless `command` is allowed by `policy`. */
export function assertSpawnAllowed(
  policy: RuntimePolicy,
  command: string,
  env?: Record<string, string | undefined>,
): void {
  if (command === "" || (!isAbsolute(command) && !isBareName(command))) {
    throw new SpawnRefusedError(command);
  }
  if (policy.run.includes(command)) return;
  const pathValue = env === undefined ? process.env.PATH : env.PATH;
  const resolved = resolveCommand(command, pathValue);
  if (resolved !== null) {
    for (const entry of policy.run) {
      if (entry === "") continue;
      if (resolveCommand(entry, pathValue) === resolved) return;
    }
  }
  throw new SpawnRefusedError(command);
}

/**
 * `spawn` from `node:child_process`, refusing a command outside `policy`.
 * Same arguments and return value; a refusal throws before anything starts.
 */
export function guardedSpawn(policy: RuntimePolicy): typeof spawn {
  return ((command: string, ...rest: unknown[]) => {
    const options = (Array.isArray(rest[0]) ? rest[1] : rest[0]) as
      | { env?: Record<string, string | undefined> }
      | undefined;
    assertSpawnAllowed(policy, command, options?.env);
    return (spawn as (...args: unknown[]) => unknown)(command, ...rest);
  }) as typeof spawn;
}
