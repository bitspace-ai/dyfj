/**
 * `dyfj dev`: work on the harness in one terminal. The launcher routes
 * `dyfj dev` here with the dev socket and its log; this program is the
 * supervisor's composition root.
 *
 * - It builds the Rust REPL (`cargo build -p dyfj-repl`, a debug build),
 *   starts a runtime on the dev socket with the real config and the real Dolt,
 *   and runs the REPL in the foreground, resuming its session across reloads.
 * - It watches `prototype/src` and `core/`, classifies each debounced batch of
 *   saves from the arch.imports graph and the Cargo workspace
 *   (`dev-classify.ts`), and restarts the runtime, the REPL, or both
 *   (`dev-supervisor.ts`).
 * - The runtime runs in its own process group, so the terminal's Ctrl-C (the
 *   REPL's) never reaches it, and with the autostarted lifetime: this
 *   supervisor holds a connection to it, and if the supervisor dies without
 *   stopping it, the runtime stops itself 10 s after its last client leaves.
 * - Quitting the REPL stops the runtime (`runtime/stop`, then SIGTERM and
 *   SIGKILL to its process group if it lingers) and ends `dyfj dev`.
 *
 * The REPL gets a control channel on descriptor 3 (`DYFJ_DEV_CONTROL_FD`):
 * see `core/dyfj-repl/src/dev_control.rs`.
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
} from "node:fs";
import { constants as osConstants } from "node:os";
import { dirname } from "node:path";
import process from "node:process";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { resolveRuntimeLaunch } from "../src/cli/launcher/runtime.ts";
import { guardedSpawn, type RuntimePolicy } from "../src/config/mod.ts";
import { connectUnixClient, type UnixClient } from "../src/transport/mod.ts";
import {
  type ClassifyContext,
  classifyBatch,
  crateMembersFromMetadata,
  loadServerReachable,
  readLayerRules,
  REPL_CRATE,
  replCrateDirs,
} from "./dev-classify.ts";
import {
  type DevReplPort,
  type DevRuntimePort,
  DevSupervisor,
  type Outcome,
  type ReplMessage,
} from "./dev-supervisor.ts";
import { coreTrees, watchTrees } from "./dev-watch.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PROTOTYPE = `${REPO}/prototype`;
const CORE = `${REPO}/core`;
const REPL_BIN = `${CORE}/target/debug/dyfj-repl`;

/** How long a starting runtime has to answer. */
const READY_TIMEOUT_MS = 60_000;
/** How long a stopping runtime has to exit before it is signalled. */
const STOP_TIMEOUT_MS = 10_000;
/** How long a REPL asked to exit has before it is signalled. */
const REPL_EXIT_TIMEOUT_MS = 5_000;
const MAX_CONTROL_LINE = 4096;
const SESSION_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const USAGE =
  "usage: dyfj dev [--model <slug>] [--session <id>] [--workspace <dir>] [--approve-paid] [--fast] [--socket <path>]";

export interface DevArgs {
  socket: string;
  log: string;
  /** The REPL's own flags, `--session` aside. */
  repl: string[];
  session: string | null;
}

/** The launcher's `--socket` and `--log`, and the flags the Rust REPL takes. */
export function parseDevArgs(argv: readonly string[]): DevArgs {
  const fail = (why: string): never => {
    throw new Error(`dyfj dev: ${why}\n${USAGE}`);
  };
  let socket: string | undefined;
  let log: string | undefined;
  let session: string | null = null;
  const repl: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) fail(`${arg} needs a value`);
      i++;
      return next!;
    };
    switch (arg) {
      case "--socket":
        socket = value();
        break;
      case "--log":
        log = value();
        break;
      case "--session":
        session = value();
        break;
      case "--model":
      case "--workspace":
        repl.push(arg, value());
        break;
      case "--approve-paid":
      case "--fast":
        repl.push(arg);
        break;
      default:
        fail(`${arg} is not an argument dyfj dev takes`);
    }
  }
  if (socket === undefined || log === undefined) fail("run it as `dyfj dev`");
  return { socket: socket!, log: log!, repl, session };
}

/** The REPL's arguments, resuming `session` when there is one. */
export function replArgs(base: readonly string[], session: string | null): string[] {
  return session === null ? [...base] : [...base, "--session", session];
}

/** One control line from the REPL, or null for anything else. */
export function parseReplMessage(line: string): ReplMessage | null {
  if (line.length > MAX_CONTROL_LINE) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  if (message.type === "reload") return { type: "reload" };
  if (
    message.type === "session" && typeof message.id === "string" &&
    SESSION_ID.test(message.id)
  ) {
    return { type: "session", id: message.id };
  }
  return null;
}

function report(line: string): void {
  process.stderr.write(`dyfj dev: ${line}\n`);
}

/** Node, cargo and the debug REPL: everything `dyfj dev` starts. */
function devPolicy(): RuntimePolicy {
  return Object.freeze({
    net: Object.freeze([]),
    run: Object.freeze([process.execPath, "cargo", REPL_BIN]),
    env: Object.freeze([]),
    dolt: null,
  });
}

// Every child goes through the config unit's guarded spawn, which holds the
// only `node:child_process` import this program needs.
const spawn = guardedSpawn(devPolicy());
type ChildProcess = ReturnType<typeof spawn>;

function exitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  const number = signal === null
    ? undefined
    : (osConstants.signals as Record<string, number>)[signal];
  return number === undefined ? 1 : 128 + number;
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

function within(promise: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run a command to completion, collecting its output. */
function run(
  command: string,
  args: string[],
  options: { cwd: string; showProgress?: boolean },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        stdio: ["ignore", "pipe", options.showProgress ? "inherit" : "pipe"],
      });
    } catch (error) {
      resolve({ code: 127, stdout: "", stderr: String(error) });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    child.once("error", (error) =>
      resolve({ code: 127, stdout: "", stderr: String(error) }));
    child.once("close", (code, signal) =>
      resolve({
        code: exitCode(code, signal),
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      }));
  });
}

async function buildRepl(showProgress = false): Promise<Outcome> {
  const result = await run("cargo", ["build", "-p", REPL_CRATE], {
    cwd: CORE,
    showProgress,
  });
  return result.code === 0
    ? { ok: true }
    : { ok: false, error: result.stderr || `cargo exited with ${result.code}` };
}

/** Workspace members, or null (with one line saying so) without cargo. */
async function readCrates(): Promise<ClassifyContext["crates"]> {
  const result = await run("cargo", ["metadata", "--no-deps", "--format-version", "1"], {
    cwd: CORE,
  });
  try {
    if (result.code !== 0) throw new Error(result.stderr);
    return crateMembersFromMetadata(JSON.parse(result.stdout), REPO);
  } catch {
    report("cargo metadata is unavailable; every change under core/ will rebuild the REPL");
    return null;
  }
}

/** The line of the runtime's log, since `offset`, that best says why it died. */
function logReason(log: string, offset: number): string {
  let text = "";
  try {
    text = readFileSync(log).subarray(offset).toString("utf8");
  } catch {
    return `see ${log}`;
  }
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.findLast((l) => /error/i.test(l)) ?? lines.at(-1) ?? `see ${log}`;
}

/** The dev runtime: one child process at a time, in its own process group. */
class DevRuntime implements DevRuntimePort {
  #child: ChildProcess | undefined;
  /** The supervisor's own connection; it keeps an autostarted runtime up. */
  #anchor: UnixClient | undefined;
  onExit: (code: number | null) => void = () => {};
  readonly socket: string;
  readonly log: string;

  constructor(socket: string, log: string) {
    this.socket = socket;
    this.log = log;
  }

  async start(): Promise<Outcome> {
    const launch = await resolveRuntimeLaunch(PROTOTYPE, this.socket, true);
    mkdirSync(dirname(this.log), { recursive: true, mode: 0o700 });
    const fd = openSync(this.log, "a", 0o600);
    const offset = statSync(this.log).size;
    writeSync(fd, `── dyfj dev runtime at ${new Date().toISOString()}, socket ${this.socket} ──\n`);
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, launch.args, {
        cwd: PROTOTYPE,
        env: launch.env,
        stdio: ["ignore", fd, fd],
        detached: true,
      });
    } finally {
      closeSync(fd);
    }
    this.#child = child;
    let gone = false;
    child.once("error", () => (gone = true));
    child.once("exit", (code) => {
      gone = true;
      if (this.#child !== child) return;
      this.#child = undefined;
      this.#anchor?.close();
      this.#anchor = undefined;
      this.onExit(code);
    });
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (!gone && Date.now() < deadline) {
      try {
        const client = await connectUnixClient(this.socket, {}, AbortSignal.timeout(500));
        await client.request("runtime/status", {}, AbortSignal.timeout(2000));
        if (gone) {
          client.close();
          break;
        }
        this.#anchor = client;
        return { ok: true };
      } catch {
        await delay(200);
      }
    }
    if (!gone) {
      await this.#terminate(child);
      return { ok: false, error: `the runtime did not answer within ${READY_TIMEOUT_MS / 1000} s` };
    }
    return { ok: false, error: logReason(this.log, offset) };
  }

  async stop(): Promise<void> {
    const child = this.#child;
    const anchor = this.#anchor;
    if (child === undefined) return;
    this.#child = undefined;
    this.#anchor = undefined;
    try {
      await anchor?.request("runtime/stop", undefined, AbortSignal.timeout(2000));
    } catch {
      // A runtime that cannot be asked is signalled below.
    }
    anchor?.close();
    if (!(await within(exited(child), STOP_TIMEOUT_MS))) await this.#terminate(child);
  }

  async inFlightTurns(): Promise<number | null> {
    try {
      const status = await this.#anchor?.request("runtime/status", {}, AbortSignal.timeout(2000));
      const count = (status as { inFlightTurns?: unknown } | undefined)?.inFlightTurns;
      return typeof count === "number" ? count : null;
    } catch {
      return null;
    }
  }

  /** SIGTERM, then SIGKILL, to the runtime's whole process group. */
  async #terminate(child: ChildProcess): Promise<void> {
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        return;
      }
      if (await within(exited(child), 3000)) return;
    }
  }
}

/** The REPL in the foreground, with its control channel on descriptor 3. */
class DevRepl implements DevReplPort {
  #child: ChildProcess | undefined;
  onMessage: (message: ReplMessage) => void = () => {};
  onExit: (code: number) => void = () => {};

  readonly socket: string;
  readonly log: string;
  readonly base: readonly string[];

  constructor(socket: string, log: string, base: readonly string[]) {
    this.socket = socket;
    this.log = log;
    this.base = base;
  }

  launch(session: string | null): void {
    const child = spawn(REPL_BIN, replArgs(this.base, session), {
      stdio: ["inherit", "inherit", "inherit", "pipe"],
      env: {
        ...process.env,
        DYFJ_SOCKET: this.socket,
        DYFJ_RUNTIME_LOG: this.log,
        DYFJ_PROTOTYPE_ROOT: PROTOTYPE,
        DYFJ_DEV_CONTROL_FD: "3",
      },
    });
    this.#child = child;
    const control = child.stdio[3] as Readable;
    let buffered = "";
    control.setEncoding("utf8");
    control.on("data", (chunk: string) => {
      buffered += chunk;
      let end: number;
      while ((end = buffered.indexOf("\n")) >= 0) {
        const message = parseReplMessage(buffered.slice(0, end));
        buffered = buffered.slice(end + 1);
        if (message !== null) this.onMessage(message);
      }
      if (buffered.length > MAX_CONTROL_LINE) buffered = "";
    });
    control.on("error", () => {});
    child.once("exit", (code, signal) => {
      if (this.#child === child) this.#child = undefined;
      this.onExit(exitCode(code, signal));
    });
  }

  async exit(): Promise<void> {
    const child = this.#child;
    if (child === undefined) return;
    this.#send(child, { type: "exit" });
    if (await within(exited(child), REPL_EXIT_TIMEOUT_MS)) return;
    child.kill("SIGTERM");
    await exited(child);
  }

  notify(message: { type: "reloading"; reason: string }): void {
    if (this.#child !== undefined) this.#send(this.#child, message);
  }

  #send(child: ChildProcess, message: object): void {
    const control = child.stdio[3] as Writable | null;
    if (control === null || control.destroyed) return;
    control.write(`${JSON.stringify(message)}\n`);
  }
}

/** A runtime already answering on the dev socket, which this one must not replace. */
async function answers(socket: string): Promise<boolean> {
  try {
    const client = await connectUnixClient(socket, {}, AbortSignal.timeout(500));
    try {
      await client.request("runtime/liveness", {}, AbortSignal.timeout(1000));
      return true;
    } finally {
      client.close();
    }
  } catch {
    return false;
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  let args: DevArgs;
  try {
    args = parseDevArgs(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }
  if (await answers(args.socket)) {
    report(`a runtime already answers at ${args.socket}; is another dyfj dev running? Stop it first.`);
    return 1;
  }

  report("building the REPL (cargo build -p dyfj-repl)");
  const built = await buildRepl(true);
  if (!built.ok) {
    report("the REPL did not build; fix it and run dyfj dev again");
    return 1;
  }

  const rules = readLayerRules(REPO);
  let reachable = loadServerReachable(REPO, rules);
  let crates = await readCrates();
  const context = (): ClassifyContext => ({
    rules,
    serverReachable: reachable,
    crates,
    replCrates: new Set(crates === null ? [] : replCrateDirs(crates, REPL_CRATE)),
  });

  const runtime = new DevRuntime(args.socket, args.log);
  report(`starting the runtime at ${args.socket} (log: ${args.log})`);
  const started = await runtime.start();
  if (!started.ok) {
    report(`the runtime did not start: ${started.error}`);
    return 1;
  }

  const repl = new DevRepl(args.socket, args.log, args.repl);
  const supervisor = new DevSupervisor({
    clock: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    classify: (paths) => {
      try {
        // Union with the previous set: a module that no longer parses, or was
        // deleted, still classifies as it did before.
        const next = loadServerReachable(REPO, rules);
        for (const path of reachable) next.add(path);
        reachable = next;
      } catch {
        // Keep the previous graph.
      }
      return classifyBatch(paths, context());
    },
    runtime,
    repl,
    build: () => buildRepl(),
    report,
  });
  runtime.onExit = (code) => supervisor.runtimeExited(code);
  repl.onMessage = (message) => supervisor.replMessage(message);
  repl.onExit = (code) => supervisor.replExited(code);

  const watcher = watchTrees(
    [{ dir: `${PROTOTYPE}/src`, prefix: "prototype/src" }, ...coreTrees(CORE, "core")],
    (path) => {
      if (path.endsWith("/Cargo.toml")) void readCrates().then((next) => (crates = next));
      supervisor.changed(path);
    },
  );

  // The terminal's Ctrl-C is the REPL's: it cancels a turn there.
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => supervisor.shutdown());
  process.on("SIGHUP", () => supervisor.shutdown());

  repl.launch(args.session);
  const code = await supervisor.done;
  watcher.close();
  return code;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
