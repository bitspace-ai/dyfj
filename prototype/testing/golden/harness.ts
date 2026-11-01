/**
 * Golden characterization harness.
 *
 * Stands up the whole system at process level and drives it from outside:
 * - an isolated Dolt fixture (schema applied, catalog models deactivated, the
 *   golden model rows seeded against a loopback model server);
 * - the engine server (`src/server/main.ts`) as a child process on a temp
 *   socket, one per server profile (see profiles.ts);
 * - the `dyfj` CLI (`src/cli/main.ts`) as a child process with piped stdin, so it
 *   is non-interactive (`exec`, `exec --json`, scripted REPL);
 * - a raw JSON-RPC client over the socket (rpc-client.ts).
 *
 * The harness imports nothing from `src/` but the launch contract (the env
 * reader and the Node permission flags the launcher uses): everything it
 * observes crosses a process, socket or database boundary, so internal moves
 * cannot break it.
 */

import { realpath } from "node:fs/promises";
import { processEnv } from "../../src/config/env.ts";
import type { ModelScript, ModelServer } from "../servers/model-server.ts";
import type { LinearMcpFake } from "./linear-mcp.ts";
import { createNormalizer, type Normalizer } from "./normalize.ts";
import type { ServerProfile } from "./profiles.ts";
import { type Approver, RawRpcClient } from "./rpc-client.ts";
import {
  type Child, type Query, type GoldenModelRow, drain, stopChild, spawnCli,
  startDisposableRuntime,
} from "../../scripts/disposable-runtime.ts";
export { prototypeRoot, networkConfig, frictionConfig } from "../../scripts/disposable-runtime.ts";
export type { GoldenModelRow } from "../../scripts/disposable-runtime.ts";
const REPL_PROMPT = "\ndyfj> ";
const START_TIMEOUT_MS = 60_000;

export interface CliRun {
  args: string[];
  stdin?: string;
  code: number;
  stdout: string;
  stderr: string;
}

export interface RowCapture {
  sessions: Record<string, unknown>[];
  events: Record<string, unknown>[];
}

export interface Harness {
  workspace: string;
  modelServer: ModelServer;
  linear: LinearMcpFake;
  /** A fresh normalizer, so ID numbering restarts for each scenario. */
  normalizer(): Normalizer;
  cli(
    profile: ServerProfile,
    args: string[],
    options?: { stdin?: string },
  ): Promise<CliRun>;
  /**
   * Scripted REPL: each line is written only after the REPL has printed its
   * next prompt, the way an operator types, then stdin is closed.
   */
  repl(
    profile: ServerProfile,
    args: string[],
    lines: string[],
  ): Promise<CliRun>;
  rpc(profile: ServerProfile, approver?: Approver): Promise<RawRpcClient>;
  /** Rows written since the previous call (all columns), in write order. */
  newRows(): Promise<RowCapture>;
  close(): Promise<void>;
}

function rowCapture(query: Query): () => Promise<RowCapture> {
  const seenEventIds = new Set<string>();
  return async () => {
    const events = (await query(
      "SELECT * FROM events ORDER BY created_at, event_id",
    )).filter((row) => !seenEventIds.has(String(row.event_id)));
    for (const row of events) seenEventIds.add(String(row.event_id));
    const sessionIds = [...new Set(events.map((row) => row.session_id))];
    const sessions = sessionIds.length === 0 ? [] : await query(
      `SELECT * FROM sessions WHERE session_id IN (${
        sessionIds.map(() => "?").join(", ")
      }) ORDER BY created_at, session_id`,
      sessionIds,
    );
    return { sessions, events };
  };
}

/** Writes `text` to the child's stdin, settling once it is flushed. */
function writeStdin(child: Child, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.process.stdin!.write(
      text,
      (error) => error ? reject(error) : resolve(),
    );
  });
}

/** Ends the child's stdin, settling once the end is flushed. */
function closeStdin(child: Child): Promise<void> {
  return new Promise((resolve) => child.process.stdin!.end(resolve));
}

async function runCli(
  child: Child,
  args: string[],
  stdin: string | undefined,
): Promise<CliRun> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const drained = Promise.all([
    drain(child.process.stdout!, stdout),
    drain(child.process.stderr!, stderr),
  ]);
  if (stdin !== undefined) await writeStdin(child, stdin);
  await closeStdin(child);
  const code = await child.closed;
  await drained;
  return {
    args,
    ...(stdin === undefined ? {} : { stdin }),
    code,
    stdout: stdout.join(""),
    stderr: stderr.join(""),
  };
}

async function runRepl(
  child: Child,
  args: string[],
  lines: string[],
): Promise<CliRun> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const drained = Promise.all([
    drain(child.process.stdout!, stdout),
    drain(child.process.stderr!, stderr),
  ]);
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (const [index, line] of lines.entries()) {
    // The (index + 1)th prompt means every earlier line has finished.
    while (stdout.join("").split(REPL_PROMPT).length - 1 < index + 1) {
      if (Date.now() > deadline) {
        await closeStdin(child);
        await stopChild(child);
        await drained.catch(() => undefined);
        throw new Error(
          `REPL did not prompt for line ${index + 1}:\n${stdout.join("")}\n` +
            stderr.join(""),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await writeStdin(child, `${line}\n`);
  }
  await closeStdin(child);
  const code = await child.closed;
  await drained;
  return {
    args,
    stdin: lines.join("\n"),
    code,
    stdout: stdout.join(""),
    stderr: stderr.join(""),
  };
}

export async function startHarness(options: {
  models: GoldenModelRow[];
  script: ModelScript;
  workspaceFiles: Record<string, string>;
}): Promise<Harness> {
  const runtime = await startDisposableRuntime({
    ...options, root: processEnv.get("DYFJ_GOLDEN_ROOT"),
  });
  const {
    root, workspace, fixture, query, modelServer, linear, launch, server, close,
  } = runtime;
  try {
    const realRoot = await realpath(root);
    return {
      workspace,
      modelServer,
      linear,
      normalizer: () =>
        createNormalizer({
          literals: [
            [fixture.root, "<DOLT_ROOT>"],
            [realRoot, "<TMP>"],
            [root, "<TMP>"],
            [modelServer.baseUrl, "<MODEL_BASE_URL>"],
            [linear.url, "<LINEAR_MCP_URL>"],
            [`127.0.0.1:${fixture.port}`, "127.0.0.1:<DOLT_PORT>"],
            [fixture.database, "<DOLT_DATABASE>"],
          ],
        }),
      cli: async (profile, args, cliOptions = {}) =>
        await runCli(
          spawnCli(launch, await server(profile), args),
          args,
          cliOptions.stdin,
        ),
      repl: async (profile, args, lines) =>
        await runRepl(
          spawnCli(launch, await server(profile), args),
          args,
          lines,
        ),
      rpc: async (profile, approver) =>
        await RawRpcClient.connect(await server(profile), approver),
      newRows: rowCapture(query),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
