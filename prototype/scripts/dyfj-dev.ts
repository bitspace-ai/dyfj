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
 * - A runtime that boots on the working tree becomes the last good code
 *   (`dev-snapshot.ts`). When one fails to start, the last good code runs
 *   instead, on the same socket with the same args and env, plus the failed
 *   start's log output, sanitized, in `DYFJ_DEV_BOOT_FAILURE`: native loopback turns
 *   carry it to the model (`src/context/dev-boot-failure.ts`).
 *
 * The REPL gets a control channel on descriptor 3 (`DYFJ_DEV_CONTROL_FD`):
 * see `core/dyfj-repl/src/dev_control.rs`.
 */

import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import { constants as osConstants } from "node:os";
import { homedir } from "node:os";
import { dirname } from "node:path";
import process from "node:process";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { resolveRuntimeLaunch } from "../src/cli/launcher/runtime.ts";
import { guardedSpawn, type RuntimePolicy } from "../src/config/mod.ts";
import { DEV_BOOT_FAILURE_ENV, sanitizeDevBootFailure } from "../src/context/mod.ts";
import type { WorkbenchRuntimeStatus } from "../src/server/rpc/runtime.ts";
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
  type StartOutcome,
} from "./dev-supervisor.ts";
import { checkSnapshot, lockFileHash, promoteSnapshot, snapshotPaths } from "./dev-snapshot.ts";
import { devTrees, watchTrees } from "./dev-watch.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PROTOTYPE = `${REPO}/prototype`;
const CORE = `${REPO}/core`;
const REPL_BIN = `${CORE}/target/debug/dyfj-repl`;
const SNAPSHOT = snapshotPaths(REPO);

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

/**
 * The environment's `DYFJ_DEV_RELOADED` for a REPL: the reason when the
 * runtime reloaded in the same change, and otherwise empty, which overrides a
 * value inherited from the operator's shell.
 */
export function reloadedEnv(reloaded: string | undefined): Record<string, string> {
  return { DYFJ_DEV_RELOADED: reloaded ?? "" };
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
  if (message.type === "rollback") return { type: "rollback" };
  if (
    message.type === "session" && typeof message.id === "string" &&
    SESSION_ID.test(message.id)
  ) {
    return { type: "session", id: message.id };
  }
  return null;
}

/**
 * Turns in flight from a `runtime/status` response, which the server shapes
 * as `{ runtime: WorkbenchRuntimeStatus }`; null when the response does not
 * say (a runtime that does not count its turns, or anything malformed).
 */
export function inFlightTurnsFrom(response: unknown): number | null {
  const runtime = (response as { runtime?: Partial<WorkbenchRuntimeStatus> } | null)
    ?.runtime;
  const count = typeof runtime === "object" && runtime !== null
    ? runtime.inFlightTurns
    : undefined;
  return typeof count === "number" ? count : null;
}

/**
 * The code a runtime loaded, from its `runtime/status` response
 * (`{ runtime: WorkbenchRuntimeStatus }`); null when it does not say.
 */
export function contentHashFrom(response: unknown): string | null {
  const runtime = (response as { runtime?: Partial<WorkbenchRuntimeStatus> } | null)
    ?.runtime;
  const hash = typeof runtime === "object" && runtime !== null
    ? runtime.fingerprint?.contentHash
    : undefined;
  return typeof hash === "string" ? hash : null;
}

const SERVER_ENTRY = "src/server/main.ts";

/** The runtime's args with its server entry swapped for the snapshot's. */
export function lastGoodArgs(args: readonly string[], entry: string): string[] {
  const at = args.indexOf(SERVER_ENTRY);
  if (at < 0) {
    throw new Error(
      "dyfj dev cannot run the last good code: the runtime's launch arguments do not " +
        `include the server entry ${SERVER_ENTRY}.`,
    );
  }
  return args.map((arg, i) => (i === at ? entry : arg));
}

const LOG_HEADER = "── dyfj dev runtime at ";

/** A failed start's own output: the log after `offset`, its header line dropped. */
export function bootFailureDetail(log: string, offset: number): string {
  const text = log.slice(offset);
  return text.startsWith(LOG_HEADER) ? text.slice(text.indexOf("\n") + 1) : text;
}

/**
 * Paths in a boot failure as the model's file tools name them: the
 * repository's prefix dropped, with or without `file://`, and the home
 * directory as `~`. Only those two literal prefixes are rewritten; a path
 * outside both, or an encoded one, is left as it is.
 */
export function localizePaths(text: string, repo: string, home: string): string {
  let out = text.replaceAll(`file://${repo}/`, "").replaceAll(`${repo}/`, "");
  if (home !== "" && home !== "/") out = out.replaceAll(home, "~");
  return out;
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

/**
 * Open the runtime's log for appending, owner-only. The runtime's whole
 * output lands in it, so it is held to what the launcher's autostart log is:
 * a 0600 regular file in a 0700 directory. Creation modes do not restrict a
 * directory or file that already exists, so both are set explicitly; a
 * symlink is refused, and anything that cannot be made owner-only throws.
 */
/** A runtime log that could not be made owner-only; names the path only. */
class LogRefusedError extends Error {}

export function openOwnerOnlyLog(
  path: string,
  owner: number | undefined = process.getuid?.(),
): number {
  const refused = (code?: string) =>
    new LogRefusedError(
      `the runtime log ${path} cannot be made owner-only${code ? ` (${code})` : ""}`,
    );
  let fd: number;
  try {
    // As the launcher's autostart does for this directory: create it 0700,
    // then set 0700 on it whether or not it existed.
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    fd = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    throw refused((error as NodeJS.ErrnoException).code);
  }
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || (owner !== undefined && before.uid !== owner)) {
      throw refused();
    }
    fchmodSync(fd, 0o600);
    if ((fstatSync(fd).mode & 0o077) !== 0) throw refused();
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error instanceof LogRefusedError
      ? error
      : refused((error as NodeJS.ErrnoException).code);
  }
}

/** The most of the runtime's log read after a failed start. */
const MAX_LOG_READ = 64 * 1024;

/**
 * The runtime's log from byte `offset`, at most `MAX_LOG_READ` bytes of it,
 * or "" when it cannot be read. However long the log has grown over many
 * reloads, only the failed start's own output is read.
 */
export function readLogSince(log: string, offset: number): string {
  let fd: number;
  try {
    fd = openSync(log, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    return "";
  }
  try {
    const buffer = Buffer.alloc(MAX_LOG_READ);
    let length = 0;
    while (length < MAX_LOG_READ) {
      const read = readSync(fd, buffer, length, MAX_LOG_READ - length, offset + length);
      if (read === 0) break;
      length += read;
    }
    return buffer.subarray(0, length).toString("utf8");
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}

/** The line of the runtime's log, since `offset`, that best says why it died. */
function logReason(log: string, offset: number): string {
  const text = readLogSince(log, offset);
  if (text === "") return `see ${log}`;
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.findLast((l) => /error/i.test(l)) ?? lines.at(-1) ?? `see ${log}`;
}

/** The failed start's output, for the last good code to show the model. */
function logDetail(log: string, offset: number): string {
  return bootFailureDetail(readLogSince(log, offset), 0);
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

  start(): Promise<StartOutcome> {
    return this.#launch((args) => args, {});
  }

  startLastGood(failure: string): Promise<StartOutcome> {
    const text = sanitizeDevBootFailure(localizePaths(failure, REPO, homedir()));
    return this.#launch(
      (args) => lastGoodArgs(args, SNAPSHOT.entry),
      { [DEV_BOOT_FAILURE_ENV]: text },
    );
  }

  /** Start a runtime and wait until it answers, or until it exits. */
  async #launch(
    argsFor: (args: string[]) => string[],
    extraEnv: Record<string, string>,
  ): Promise<StartOutcome> {
    const launch = await resolveRuntimeLaunch(PROTOTYPE, this.socket, true);
    const lockHash = await lockFileHash(SNAPSHOT.lock);
    let fd: number;
    try {
      fd = openOwnerOnlyLog(this.log);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const offset = fstatSync(fd).size;
    writeSync(fd, `${LOG_HEADER}${new Date().toISOString()}, socket ${this.socket} ──\n`);
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, argsFor(launch.args), {
        cwd: PROTOTYPE,
        env: { ...launch.env, ...extraEnv },
        stdio: ["ignore", fd, fd],
        detached: true,
      });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
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
      let client: UnixClient | undefined;
      try {
        client = await connectUnixClient(this.socket, {}, AbortSignal.timeout(500));
        const status = await client.request("runtime/status", {}, AbortSignal.timeout(2000));
        if (gone) break;
        this.#anchor = client;
        client = undefined;
        return { ok: true, contentHash: contentHashFrom(status), lockHash };
      } catch {
        await delay(200);
      } finally {
        client?.close();
      }
    }
    if (!gone) {
      await this.#terminate(child);
      return {
        ok: false,
        error: `the runtime did not answer within ${READY_TIMEOUT_MS / 1000} s`,
        detail: logDetail(this.log, offset),
      };
    }
    return {
      ok: false,
      error: logReason(this.log, offset),
      detail: logDetail(this.log, offset),
    };
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
      return inFlightTurnsFrom(
        await this.#anchor?.request("runtime/status", {}, AbortSignal.timeout(2000)),
      );
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

  launch(session: string | null, reloaded?: string): void {
    const child = spawn(REPL_BIN, replArgs(this.base, session), {
      stdio: ["inherit", "inherit", "inherit", "pipe"],
      env: {
        ...process.env,
        DYFJ_SOCKET: this.socket,
        DYFJ_RUNTIME_LOG: this.log,
        DYFJ_PROTOTYPE_ROOT: PROTOTYPE,
        DYFJ_DEV_CONTROL_FD: "3",
        ...reloadedEnv(reloaded),
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
    snapshot: {
      check: () => checkSnapshot(SNAPSHOT),
      promote: (contentHash, lockHash) =>
        promoteSnapshot(SNAPSHOT, contentHash, new Date(), lockHash),
    },
  });
  runtime.onExit = (code) => supervisor.runtimeExited(code);
  repl.onMessage = (message) => supervisor.replMessage(message);
  repl.onExit = (code) => supervisor.replExited(code);

  report(`starting the runtime at ${args.socket} (log: ${args.log})`);
  if (!(await supervisor.boot())) return 1;

  const watcher = watchTrees(
    devTrees(REPO),
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
