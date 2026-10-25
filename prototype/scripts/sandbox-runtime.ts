/**
 * The Workbench runtime's entry point in the isolated machine (BIT-779). It is
 * started by `dyfj-sandbox serve` as the runtime role, through
 * `sandbox/linux/l8-work.sh`:
 *
 *   node sandbox-runtime.ts [--secrets <dir>]
 *
 * The role's environment is cleared, and the runtime's `[secrets] command`
 * may only run the role's run grants, so the bootstrap secrets the broker
 * delivered (`/secrets/<NAME>`, files only the runtime's uid can read) reach
 * the runtime here. For each declared secret env var that the runtime policy
 * grants and that is unset or empty, a non-empty file of that name becomes
 * the variable's value in the runtime's environment, byte for byte (a
 * leading byte-order mark included). A file that is not UTF-8, or holds a
 * NUL, is refused by name. Nothing else is read, and no value is
 * printed: the one line it writes names the variables set.
 *
 * It then runs `src/server/main.ts --autostarted` as its child, so the
 * runtime stops 10 s after its last client leaves, forwards SIGINT, SIGTERM
 * and SIGHUP to it, and exits with its status, or 128 plus the signal's
 * number when a signal ended it, or 1 when it could not be started. The
 * supervisor's lease follows this process.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { RUNTIME_ENV_GRANTS } from "../src/config/runtime-policy.ts";
import { declaredSecretEnvVars } from "../src/config/schema.ts";

export const SECRETS_DIR = "/secrets";

/** The env vars a delivered file may set: declared secrets the runtime may read. */
export function deliverableNames(): readonly string[] {
  return declaredSecretEnvVars().filter((name) => RUNTIME_ENV_GRANTS.includes(name));
}

/**
 * The variables to set from the secrets directory: each deliverable name that
 * is unset or empty in `existing` and `read` returns a non-empty value for. `read` returns
 * undefined for a file that is absent. A value that is not UTF-8, or holds a
 * NUL, is refused by name.
 */
export function secretEnvironment(
  names: readonly string[],
  read: (name: string) => Buffer | undefined,
  existing: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    if (existing[name] !== undefined && existing[name] !== "") continue;
    const bytes = read(name);
    if (bytes === undefined || bytes.length === 0) continue;
    let value: string;
    try {
      value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new Error(`${name}: the delivered value is not UTF-8 text`);
    }
    if (value.includes("\u0000")) throw new Error(`${name}: the delivered value holds a NUL byte`);
    out[name] = value;
  }
  return out;
}

function readSecret(dir: string, name: string): Buffer | undefined {
  try {
    return readFileSync(`${dir}/${name}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`${name}: cannot read the delivered file (${(error as NodeJS.ErrnoException).code})`);
  }
}

/**
 * Runs `program` with `args` and `env` as the server child, forwarding
 * SIGINT, SIGTERM and SIGHUP to it, and resolves to the exit status to take:
 * the child's, 128 plus the signal's number when a signal ended it, or 1 when
 * the child could not be started. A launch failure is reported by its error
 * code alone, so no part of `env` reaches the message.
 */
export function runServer(
  program: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  report: (line: string) => void = (line) => void process.stderr.write(line),
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(program, args, { stdio: "inherit", env });
    const forward = (signal: NodeJS.Signals) => () => void child.kill(signal);
    const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((signal) => {
      const handler = forward(signal);
      process.on(signal, handler);
      return [signal, handler] as const;
    });
    const done = (status: number) => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      resolve(status);
    };
    child.once("error", (error: NodeJS.ErrnoException) => {
      report(`sandbox-runtime: cannot start the server (${error.code ?? "unknown error"})\n`);
      done(1);
    });
    child.once("exit", (code, signal) => {
      done(code ?? (signal === null ? 1 : 128 + (constants.signals[signal] ?? 0)));
    });
  });
}

async function main(args: readonly string[]) {
  const at = args.indexOf("--secrets");
  const dir = at === -1 ? SECRETS_DIR : args[at + 1];
  if (dir === undefined) throw new Error("--secrets needs a directory");
  const set = secretEnvironment(deliverableNames(), (name) => readSecret(dir, name), process.env);
  process.stderr.write(
    `sandbox-runtime: set ${Object.keys(set).length === 0 ? "no secrets" : Object.keys(set).join(", ")} from ${dir}\n`,
  );
  const server = fileURLToPath(new URL("../src/server/main.ts", import.meta.url));
  process.exitCode = await runServer(process.execPath, [server, "--autostarted"], { ...process.env, ...set });
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`sandbox-runtime: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}
