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
      : `dyfj: foreground process; Ctrl-C signals runtime shutdown; the shell may return before cleanup settles`,
  );
  try {
    return await startRuntime(config, { autostarted });
  } catch (error) {
    io.err(`dyfj: could not start local runtime: ${summarizeError(error)}`);
    io.err(`dyfj: fallback command: cd prototype && deno task serve-unix`);
    return 1;
  }
}
