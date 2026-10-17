/** `dyfj start`: run the local runtime in the foreground (or autostarted). */

import { summarizeError } from "../../contract/mod.ts";
import type { CliConfig } from "../args.ts";
import type { Io } from "../io.ts";
import {
  startLocalRuntime,
  type StartRuntimeOptions,
} from "../launcher/runtime.ts";

export type StartRuntimeFn = (
  config: CliConfig,
  options?: StartRuntimeOptions,
) => Promise<number>;

/** `value` as one POSIX shell word: single-quoted, each `'` closed and escaped. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export async function runStart(
  config: CliConfig,
  io: Io,
  startRuntime: StartRuntimeFn = startLocalRuntime,
  autostarted = false,
): Promise<number> {
  io.err(`dyfj: starting local runtime at ${config.socket}`);
  io.err(
    autostarted
      ? `dyfj: autostarted process; after its signal handler is ready, client Ctrl-C leaves the runtime running`
      : `dyfj: foreground process; Ctrl-C stops the runtime (again: shows what shutdown waits on; a third time: forces exit)`,
  );
  try {
    return await startRuntime(config, { autostarted });
  } catch (error) {
    io.err(`dyfj: could not start local runtime: ${summarizeError(error)}`);
    io.err(
      `dyfj: fallback command: cd prototype && DYFJ_SOCKET=${
        shellQuote(config.socket)
      } node --env-file-if-exists=.env src/server/main.ts`,
    );
    return 1;
  }
}
