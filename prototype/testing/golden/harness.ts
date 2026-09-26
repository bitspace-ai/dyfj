/**
 * Golden characterization harness.
 *
 * Stands up the whole system at process level and drives it from outside:
 * - an isolated Dolt fixture (schema applied, catalog models deactivated, the
 *   golden model rows seeded against a loopback model server);
 * - the engine server (`src/uds-serve.ts`) as a child process on a temp
 *   socket, one per server profile (see profiles.ts);
 * - the `dyfj` CLI (`src/cli.ts`) as a child process with piped stdin, so it
 *   is non-interactive (`exec`, `exec --json`, scripted REPL);
 * - a raw JSON-RPC client over the socket (rpc-client.ts).
 *
 * The harness imports nothing from `src/`: everything it observes crosses a
 * process, socket or database boundary, so internal moves cannot break it.
 */

import mysql from "mysql2/promise";
import { fileURLToPath } from "node:url";
import { startIsolatedDoltFixture } from "../../scripts/isolated-dolt-fixture.ts";
import {
  type ModelScript,
  type ModelServer,
  startModelServer,
} from "../servers/model-server.ts";
import {
  LINEAR_ISSUE_IDENTIFIER,
  LINEAR_MCP_TOKEN,
  type LinearMcpFake,
  startLinearMcpFake,
} from "./linear-mcp.ts";
import { createNormalizer, type Normalizer } from "./normalize.ts";
import { type ServerProfile, socketPathFor } from "./profiles.ts";
import { type Approver, RawRpcClient } from "./rpc-client.ts";

export const prototypeRoot = fileURLToPath(new URL("../..", import.meta.url))
  .replace(/[\\/]$/, "");
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url))
  .replace(/[\\/]$/, "");

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const REPL_PROMPT = "\ndyfj> ";
const START_TIMEOUT_MS = 60_000;

export interface GoldenModelRow {
  slug: string;
  displayName: string;
  tier: 0 | 1 | 2;
  contextWindow: number;
  maxOutputTokens: number;
  costInput: number;
  costOutput: number;
  capabilities: string[];
}

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

type Query = (
  sql: string,
  params?: unknown[],
) => Promise<Record<string, unknown>[]>;

interface PermissionProfile {
  env: string[];
  run: string[];
  sys?: string[];
}

/** Everything a child launch needs, fixed once the harness is up. */
interface LaunchContext {
  root: string;
  workspace: string;
  baseEnv: Record<string, string>;
  dbEnv: Record<string, string>;
  linearUrl: string;
  server: PermissionProfile;
  cli: PermissionProfile;
}

// ── Setup ───────────────────────────────────────────────────────────────────

async function denoDir(): Promise<string> {
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
    stderr: "null",
  }).output();
  const info = JSON.parse(decoder.decode(output.stdout)) as {
    denoDir?: string;
  };
  if (typeof info.denoDir !== "string") {
    throw new Error("deno info did not report a cache directory");
  }
  return info.denoDir;
}

// The committed permission profiles are the engine's and the CLI's
// permission contracts. The harness reuses their env, run and sys grants
// verbatim; it replaces only the net grant (the server's fixed ports become
// the loopback host and its socket), and adds the executable it launched
// them with. Read and write are unscoped in both profiles.
async function permissionProfiles(): Promise<
  { server: PermissionProfile; cli: PermissionProfile }
> {
  const config = JSON.parse(
    await Deno.readTextFile(`${prototypeRoot}/deno.json`),
  ) as { permissions: Record<string, PermissionProfile> };
  return {
    server: config.permissions["serve-unix"],
    cli: config.permissions["cli"],
  };
}

async function seedModels(
  query: Query,
  baseUrl: string,
  models: GoldenModelRow[],
): Promise<void> {
  // The catalog's own rows point at fixed local ports; deactivate them so
  // routing sees only the golden rows, whatever the catalog holds.
  await query("UPDATE models SET active = FALSE");
  for (const model of models) {
    await query(
      "INSERT INTO models (slug, display_name, provider, api, base_url, " +
        "tier, context_window, max_output_tokens, cost_input, cost_output, " +
        "cost_cache_read, cost_cache_write, reasoning, capabilities, active) " +
        "VALUES (?, ?, 'mlx-lm', 'openai-completions', ?, ?, ?, ?, ?, ?, " +
        "0, 0, FALSE, ?, TRUE)",
      [
        model.slug,
        model.displayName,
        baseUrl,
        model.tier,
        model.contextWindow,
        model.maxOutputTokens,
        model.costInput,
        model.costOutput,
        JSON.stringify(model.capabilities),
      ],
    );
  }
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

// ── Child processes ─────────────────────────────────────────────────────────

async function stopChild(child: Deno.ChildProcess): Promise<void> {
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  const timeout = new Promise<"timeout">((resolve) => {
    const id = setTimeout(() => resolve("timeout"), 5_000);
    void child.status.finally(() => clearTimeout(id));
  });
  const outcome = await Promise.race([
    child.status.then(() => "exited" as const),
    timeout,
  ]);
  if (outcome === "timeout") {
    try {
      child.kill("SIGKILL");
    } catch {
      // Exited in the meantime.
    }
    await child.status;
  }
}

async function drain(
  stream: ReadableStream<Uint8Array>,
  sink: string[],
): Promise<void> {
  const streamDecoder = new TextDecoder();
  for await (const chunk of stream) {
    sink.push(streamDecoder.decode(chunk, { stream: true }));
  }
}

function frictionConfig(linearUrl: string): string {
  // The secret resolver prints its pointer; the pointer is the token.
  return [
    "[secrets]",
    'command = ["/bin/echo"]',
    "",
    "[secrets.named]",
    `linear_mcp = "${LINEAR_MCP_TOKEN}"`,
    "",
    "[[mcp.servers]]",
    'id = "linear"',
    'transport = "streamable_http"',
    `url = "${linearUrl}"`,
    'minimum_clearance = "loopback"',
    'auth = { type = "bearer", secret = "linear_mcp" }',
    "tools = [",
    '  { name = "get_issue", effect = "read", approval = "allow" },',
    '  { name = "list_comments", effect = "read", approval = "allow" },',
    '  { name = "create_comment", effect = "write_external", approval = "ask" },',
    "]",
    "",
  ].join("\n");
}

async function waitForLiveness(
  socket: string,
  describe: () => string,
): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    try {
      const probe = await RawRpcClient.connect(socket);
      let answered = false;
      try {
        answered = (await probe.call("runtime/liveness")).result !== undefined;
      } finally {
        await probe.close();
      }
      if (answered) return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(describe());
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Start one engine server for a profile; resolves once it answers. */
async function startEngineServer(
  launch: LaunchContext,
  profile: ServerProfile,
): Promise<{ socket: string; stop(): Promise<void> }> {
  const socket = socketPathFor(launch.root, profile);
  const dir = socket.slice(0, socket.lastIndexOf("/"));
  await Deno.mkdir(dir);
  if (profile.friction) {
    await Deno.writeTextFile(
      `${dir}/config.toml`,
      frictionConfig(launch.linearUrl),
    );
  }
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-prompt",
      `--config=${prototypeRoot}/deno.json`,
      `--allow-env=${launch.server.env.join(",")}`,
      "--allow-read",
      "--allow-write",
      // `dyfj start` likewise appends the configured secret resolver.
      `--allow-run=${
        [
          ...launch.server.run,
          Deno.execPath(),
          ...(profile.friction ? ["/bin/echo"] : []),
        ].join(",")
      }`,
      `--allow-sys=${(launch.server.sys ?? []).join(",")}`,
      `--allow-net=127.0.0.1,unix:${socket}`,
      `${prototypeRoot}/src/uds-serve.ts`,
    ],
    cwd: dir,
    clearEnv: true,
    env: {
      ...launch.baseEnv,
      ...launch.dbEnv,
      DYFJ_SOCKET: socket,
      DYFJ_ROOT: dir,
      DYFJ_PRINCIPAL_ID: "golden-operator",
      ...(profile.friction
        ? { DYFJ_FRICTION_ISSUE_ID: LINEAR_ISSUE_IDENTIFIER }
        : {}),
      ...profile.env,
    },
    stdin: "null",
    stdout: "null",
    stderr: "piped",
  }).spawn();
  const stderr: string[] = [];
  const drained = drain(child.stderr, stderr);
  const stop = async () => {
    await stopChild(child);
    await drained.catch(() => undefined);
  };
  try {
    await waitForLiveness(
      socket,
      () =>
        `engine server (${profile.name}) did not start:\n${stderr.join("")}`,
    );
  } catch (error) {
    await stop();
    throw error;
  }
  return { socket, stop };
}

function spawnCli(
  launch: LaunchContext,
  socket: string,
  args: string[],
): Deno.ChildProcess {
  return new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-prompt",
      `--config=${prototypeRoot}/deno.json`,
      `--allow-env=${launch.cli.env.join(",")}`,
      "--allow-read",
      "--allow-write",
      `--allow-run=${[...launch.cli.run, Deno.execPath()].join(",")}`,
      `--allow-net=unix:${socket}`,
      `${prototypeRoot}/src/cli.ts`,
      ...args,
      "--socket",
      socket,
    ],
    cwd: launch.workspace,
    clearEnv: true,
    env: launch.baseEnv,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
}

async function runCli(
  child: Deno.ChildProcess,
  args: string[],
  stdin: string | undefined,
): Promise<CliRun> {
  const writer = child.stdin.getWriter();
  if (stdin !== undefined) await writer.write(encoder.encode(stdin));
  await writer.close();
  const output = await child.output();
  return {
    args,
    ...(stdin === undefined ? {} : { stdin }),
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  };
}

async function runRepl(
  child: Deno.ChildProcess,
  args: string[],
  lines: string[],
): Promise<CliRun> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const drained = Promise.all([
    drain(child.stdout, stdout),
    drain(child.stderr, stderr),
  ]);
  const writer = child.stdin.getWriter();
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (const [index, line] of lines.entries()) {
    // The (index + 1)th prompt means every earlier line has finished.
    while (stdout.join("").split(REPL_PROMPT).length - 1 < index + 1) {
      if (Date.now() > deadline) {
        await writer.close().catch(() => undefined);
        await stopChild(child);
        throw new Error(
          `REPL did not prompt for line ${index + 1}:\n${stdout.join("")}\n` +
            stderr.join(""),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await writer.write(encoder.encode(`${line}\n`));
  }
  await writer.close();
  const status = await child.status;
  await drained;
  return {
    args,
    stdin: lines.join("\n"),
    code: status.code,
    stdout: stdout.join(""),
    stderr: stderr.join(""),
  };
}

// ── Harness ─────────────────────────────────────────────────────────────────

export async function startHarness(options: {
  models: GoldenModelRow[];
  script: ModelScript;
  workspaceFiles: Record<string, string>;
}): Promise<Harness> {
  // The lane runner creates the root up front so it can grant the exact
  // socket paths; a direct `deno test` run gets a root of its own.
  const givenRoot = Deno.env.get("DYFJ_GOLDEN_ROOT");
  const root = givenRoot ?? await Deno.makeTempDir({ prefix: "dyfj_golden_" });
  const cleanups: Array<() => Promise<void>> = givenRoot === undefined
    ? [() => Deno.remove(root, { recursive: true })]
    : [];
  const close = async () => {
    for (const step of cleanups.reverse()) {
      await step().catch(() => undefined);
    }
  };
  try {
    const home = `${root}/home`;
    const workspace = `${root}/workspace`;
    await Deno.mkdir(home);
    await Deno.mkdir(workspace);
    for (const [name, content] of Object.entries(options.workspaceFiles)) {
      await Deno.writeTextFile(`${workspace}/${name}`, content);
    }

    const fixture = await startIsolatedDoltFixture({
      repoRoot,
      prefix: "dyfj_golden_db_",
    });
    cleanups.push(() => fixture.cleanup());
    const pool = mysql.createPool({
      host: fixture.env.DOLT_HOST,
      port: Number(fixture.env.DOLT_PORT),
      user: fixture.env.DOLT_USER,
      password: fixture.env.DOLT_PASSWORD,
      database: fixture.env.DOLT_DATABASE,
      connectionLimit: 1,
      dateStrings: true,
    }) as unknown as {
      query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
      end(): Promise<void>;
    };
    cleanups.push(() => pool.end());
    const query: Query = async (sql, params = []) =>
      (await pool.query(sql, params))[0] as Record<string, unknown>[];

    const modelServer = startModelServer(options.script);
    cleanups.push(() => modelServer.close());
    const linear = startLinearMcpFake();
    cleanups.push(() => linear.close());
    await seedModels(query, modelServer.baseUrl, options.models);

    const launch: LaunchContext = {
      root,
      workspace,
      baseEnv: {
        PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
        HOME: home,
        USER: "golden",
        TZ: "UTC",
        DENO_DIR: await denoDir(),
        NO_COLOR: "1",
      },
      dbEnv: fixture.env,
      linearUrl: linear.url,
      ...await permissionProfiles(),
    };
    const sockets = new Map<string, Promise<string>>();
    const server = (profile: ServerProfile): Promise<string> => {
      let socket = sockets.get(profile.name);
      if (socket === undefined) {
        socket = startEngineServer(launch, profile).then((started) => {
          cleanups.push(started.stop);
          return started.socket;
        });
        sockets.set(profile.name, socket);
      }
      return socket;
    };

    const realRoot = await Deno.realPath(root);
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
