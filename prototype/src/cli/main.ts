/**
 * dyfj — the `dyfj` client entrypoint: parse the arguments, then dispatch to
 * a one-shot turn, a subcommand, or the interactive REPL.
 *
 * A THIN client over the Workbench runtime's JSON-RPC/UDS seam — it never
 * imports the engine (no mysql2, no provider SDKs), so the compiled binary
 * stays small and the server can migrate to Rust under the same contract.
 *
 *   dyfj exec "<prompt>"   one-shot; streams text to stdout, receipt to stderr
 *   dyfj exec --json ...    one-shot; full result JSON to stdout (buffered)
 *   dyfj                    interactive line REPL (multi-turn, streaming)
 *
 * Assumes the runtime server is running; use `dyfj status` to check it and
 * `dyfj start` to foreground the local UDS runtime.
 */

import { processEnv } from "../config/mod.ts";
import { connectUnixClient } from "../transport/mod.ts";
import { runRepl } from "../cli.ts";
import { runExec } from "./commands/exec.ts";
import { HELP, parseArgs, resolveConfig } from "./args.ts";
import { type Io, realIo } from "./io.ts";
import { runModels } from "./commands/models.ts";
import { runSessions } from "./commands/sessions.ts";
import { runStart } from "./commands/start.ts";
import { runStatus } from "./commands/status.ts";
import { runStop } from "./commands/stop.ts";
import { startLocalRuntime } from "./launcher/runtime.ts";

export async function main(argv: string[], io: Io): Promise<number> {
  // Launcher-internal: `--parse-check <args…>` validates the remaining
  // arguments against this client's own parser and exits 0 (valid) or 2
  // (rejected), silently, touching nothing else. It exists so the launcher's
  // autostart decision can share THIS parser as its single validity contract
  // instead of mirroring it in shell — an invocation this parser would reject
  // must not spawn a runtime on its way to the usage error.
  if (argv[0] === "--parse-check") {
    try {
      return parseArgs(argv.slice(1)).error ? 2 : 0;
    } catch {
      // parseArgs can throw on some invalid values (session refs) rather than
      // returning a parse error; parse-check's contract is 0/2 regardless of
      // which shape the rejection takes.
      return 2;
    }
  }
  const parsed = parseArgs(argv);
  if (parsed.error) io.err(`dyfj: ${parsed.error}`);
  if (parsed.command === "help") {
    io.err(HELP);
    return parsed.error ? 2 : 0;
  }
  const config = resolveConfig(
    parsed.overrides,
    processEnv,
    Deno.stdout.isTerminal(),
    Deno.cwd(),
  );
  const interactive = Deno.stdin.isTerminal();
  if (parsed.command === "exec") {
    return await runExec(
      parsed.prompt!,
      config,
      io,
      parsed.json,
      connectUnixClient,
      interactive,
    );
  }
  if (parsed.command === "models") {
    return await runModels(config, io);
  }
  if (parsed.command === "sessions") {
    return await runSessions(config, io);
  }
  if (parsed.command === "status") {
    return await runStatus(config, io);
  }
  if (parsed.command === "stop") {
    return await runStop(config, io);
  }
  if (parsed.command === "start") {
    return await runStart(
      config,
      io,
      startLocalRuntime,
      parsed.launcherAutostarted === true,
    );
  }
  return await runRepl(config, io, connectUnixClient, interactive);
}

if (import.meta.main) {
  const io = realIo();
  const code = await main(Deno.args, io);
  io.close();
  Deno.exit(code);
}
