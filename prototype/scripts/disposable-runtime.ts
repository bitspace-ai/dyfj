/** Shared process-level boot path for golden tests and disposable runtimes. */
import mysql from "mysql2/promise";
import { type ChildProcess, spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { startIsolatedDoltFixture } from "./isolated-dolt-fixture.ts";
import { processEnv } from "../src/config/env.ts";
import {
  CLI_NODE_PERMISSION_FLAGS,
  nodePermissionArgs,
  RUNTIME_NODE_PERMISSION_FLAGS,
} from "../src/config/runtime-policy.ts";
import {
  type ModelScript,
  startModelServer,
} from "../testing/servers/model-server.ts";
import {
  LINEAR_ISSUE_IDENTIFIER,
  LINEAR_MCP_TOKEN,
  startLinearMcpFake,
} from "../testing/golden/linear-mcp.ts";
import { type ServerProfile, socketPathFor } from "../testing/golden/profiles.ts";
import { RawRpcClient } from "../testing/golden/rpc-client.ts";

export const prototypeRoot = fileURLToPath(new URL("..", import.meta.url))
  .replace(/[\\/]$/, "");
const repoRoot = fileURLToPath(new URL("../..", import.meta.url))
  .replace(/[\\/]$/, "");

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

export type Query = (
  sql: string,
  params?: unknown[],
) => Promise<Record<string, unknown>[]>;

/** Everything a child launch needs, fixed once the harness is up. */
export interface LaunchContext {
  root: string;
  containChildren?: boolean;
  workspace: string;
  baseEnv: Record<string, string>;
  dbEnv: Record<string, string>;
  linearUrl: string;
  /** The loopback model server's `host:port`, for `[network] allow`. */
  modelHost: string;
}

// ── Setup ───────────────────────────────────────────────────────────────────

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

/** A spawned child and its exit, settled once its stdio has closed too. */
export interface Child {
  group?: boolean;
  process: ChildProcess;
  /** The exit code; a signal death reads as 128 plus the signal number. */
  closed: Promise<number>;
}

export function started(process: ChildProcess): Child {
  const closed = new Promise<number>((resolve, reject) => {
    process.once("error", reject);
    process.once("close", (code, signal) => {
      resolve(
        code ?? 128 + (signal === null ? 0 : constants.signals[signal]),
      );
    });
  });
  return { process, closed };
}

export async function stopChild(child: Child): Promise<void> {
  const signal = (name: NodeJS.Signals) => {
    if (!child.group) return child.process.kill(name);
    try { process.kill(-child.process.pid!, name); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
  };
  if (!signal("SIGTERM")) {
    // Already exited (or never started): wait for its stdio to close.
    await child.closed.catch(() => undefined);
    return;
  }
  const timeout = new Promise<"timeout">((resolve) => {
    const id = setTimeout(() => resolve("timeout"), 5_000);
    void child.closed.catch(() => undefined).finally(() => clearTimeout(id));
  });
  const outcome = await Promise.race([
    child.closed.then(() => "exited" as const, () => "exited" as const),
    timeout,
  ]);
  if (outcome === "timeout") {
    // A no-op if it exited in the meantime.
    signal("SIGKILL");
  }
  await child.closed.catch(() => undefined);
  // Descendants may outlive the engine even after its own stdio closes.
  if (child.group) signal("SIGKILL");
}

export async function drain(
  stream: Readable,
  sink: string[],
): Promise<void> {
  const streamDecoder = new TextDecoder();
  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    sink.push(streamDecoder.decode(chunk, { stream: true }));
  }
}

/**
 * The `[network]` table every profile's config.toml carries: the engine's
 * network policy admits the loopback model server's random port only through
 * it, as an operator admits a local server on a non-default port.
 */
export function networkConfig(modelHost: string): string {
  return ["[network]", `allow = ["${modelHost}"]`, ""].join("\n");
}

export function frictionConfig(linearUrl: string): string {
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
export async function startEngineServer(
  launch: LaunchContext,
  profile: ServerProfile,
): Promise<{ socket: string; pid: number; stop(): Promise<void> }> {
  const socket = socketPathFor(launch.root, profile);
  const dir = socket.slice(0, socket.lastIndexOf("/"));
  await mkdir(dir);
  await writeFile(
    `${dir}/config.toml`,
    networkConfig(launch.modelHost) +
      (profile.friction ? `\n${frictionConfig(launch.linearUrl)}` : ""),
  );
  // The runtime's launch, as `dyfj start` makes it: this Node under the
  // runtime's permission flags, with an explicit environment.
  const child = started(spawn(
    process.execPath,
    [
      ...nodePermissionArgs(RUNTIME_NODE_PERMISSION_FLAGS),
      `${prototypeRoot}/src/server/main.ts`,
    ],
    {
      cwd: dir,
      detached: launch.containChildren,
      env: {
        ...launch.baseEnv,
        ...launch.dbEnv,
        DYFJ_SOCKET: socket,
        DYFJ_ROOT: dir,
        DYFJ_PRINCIPAL_ID: "golden-operator",
        // The tool sandbox (BIT-662) runs only where srt can, so snapshots
        // would differ by machine. The suite characterizes the prompting
        // route; srt-sandbox.integration.test.ts covers the sandboxed one.
        DYFJ_SANDBOX: "off",
        ...(profile.friction
          ? { DYFJ_FRICTION_ISSUE_ID: LINEAR_ISSUE_IDENTIFIER }
          : {}),
        ...profile.env,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  ));
  child.group = launch.containChildren;
  const stderr: string[] = [];
  const drained = drain(child.process.stderr!, stderr);
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
  return { socket, pid: child.process.pid!, stop };
}

export function spawnCli(
  launch: LaunchContext,
  socket: string,
  args: string[],
): Child {
  // The client's launch, as the dyfj launcher makes it.
  return started(spawn(
    process.execPath,
    [
      ...nodePermissionArgs(CLI_NODE_PERMISSION_FLAGS),
      `${prototypeRoot}/src/cli/main.ts`,
      ...args,
      "--socket",
      socket,
    ],
    {
      cwd: launch.workspace,
      env: launch.baseEnv,
      stdio: ["pipe", "pipe", "pipe"],
    },
  ));
}

export async function startDisposableRuntime(options: {
  models: GoldenModelRow[];
  script: ModelScript;
  workspaceFiles: Record<string, string>;
  root?: string;
  fixtureUnderRoot?: boolean;
  containChildren?: boolean;
  signal?: AbortSignal;
}) {
  // The lane runner creates the root up front so it can grant the exact
  // socket paths; a direct `node --test` run gets a root of its own.
  const givenRoot = options.root;
  const root = givenRoot ?? await mkdtemp(join(tmpdir(), "dyfj_golden_"));
  const cleanups: Array<() => Promise<void>> = givenRoot === undefined
    ? [() => rm(root, { recursive: true })]
    : [];
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    const errors: unknown[] = [];
    for (const step of [...cleanups].reverse()) {
      try { await step(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "runtime cleanup failed");
  })();
  try {
    const home = `${root}/home`;
    const workspace = `${root}/workspace`;
    await mkdir(home);
    await mkdir(workspace);
    for (const [name, content] of Object.entries(options.workspaceFiles)) {
      await writeFile(`${workspace}/${name}`, content);
    }

    const fixture = await startIsolatedDoltFixture({
      repoRoot,
      prefix: "dyfj_golden_db_",
      signal: options.signal,
      ...(options.fixtureUnderRoot ? { parent: root } : {}),
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

    const modelServer = await startModelServer(options.script);
    cleanups.push(() => modelServer.close());
    const linear = await startLinearMcpFake();
    cleanups.push(() => linear.close());
    await seedModels(query, modelServer.baseUrl, options.models);

    const launch: LaunchContext = {
      root,
      containChildren: options.containChildren,
      workspace,
      baseEnv: {
        PATH: processEnv.get("PATH") ?? "/usr/bin:/bin",
        HOME: home,
        ...(options.fixtureUnderRoot ? { TMPDIR: `${root}/tmp`, TMP: `${root}/tmp`, TEMP: `${root}/tmp` } : {}),
        USER: "golden",
        TZ: "UTC",
        NO_COLOR: "1",
      },
      dbEnv: fixture.env,
      linearUrl: linear.url,
      modelHost: new URL(modelServer.baseUrl).host,
    };
    const pids: number[] = [];
    const environments = new Map<string, Record<string, string>>();
    const sockets = new Map<string, Promise<string>>();
    const server = (profile: ServerProfile): Promise<string> => {
      let socket = sockets.get(profile.name);
      if (socket === undefined) {
        socket = startEngineServer(launch, profile).then((started) => {
          cleanups.push(started.stop);
          pids.push(started.pid);
          environments.set(profile.name, {
            ...launch.baseEnv, ...launch.dbEnv, ...profile.env,
            DYFJ_ROOT: `${root}/${profile.name}`, DYFJ_SOCKET: started.socket,
          });
          return started.socket;
        });
        sockets.set(profile.name, socket);
      }
      return socket;
    };

    return { root, workspace, fixture, query, modelServer, linear, launch,
      server, pids, environments, close };
  } catch (error) {
    await close();
    throw error;
  }
}
