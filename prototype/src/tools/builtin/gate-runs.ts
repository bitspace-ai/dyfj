import { closeSync, constants, fchmodSync, mkdirSync, openSync, realpathSync, writeSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { clipToUtf8Bytes } from "../../kernel/mod.ts";
import { randomUUID } from "node:crypto";
import { baseRuntimePolicy, type Env, processEnv, type GateMode, type RuntimePolicy } from "../../config/mod.ts";
import { runBounded, type BoundedResult } from "./bounded-process.ts";
import type { CommandSandbox } from "./srt-sandbox.ts";

export interface GateView {
  run: string;
  state: "running" | "passed" | "failed" | "timed-out" | "cancelled" | "unknown";
  mode: GateMode | null;
  paths: readonly string[];
  exitCode: number | null;
  statusLine: string | null;
  tail: string;
  logPath: string | null;
}
interface RecordRun {
  view: GateView;
  abort: AbortController;
  done: Promise<void>;
}
export interface GateRunInput {
  root: string;
  mode: GateMode;
  paths: readonly string[];
  argv: readonly string[];
  env: Record<string, string>;
  timeoutMs: number;
  sandbox?: CommandSandbox;
  policy?: RuntimePolicy;
}
const TAIL_BYTES = 16384;

/** Ephemeral, single-writer run state. The runtime owns one registry across turns. */
export class GateRuns {
  readonly #sessions = new Map<string, Map<string, RecordRun>>();
  readonly #env: Env;

  constructor(env: Env = processEnv) { this.#env = env; }


  active(session: string): string | undefined {
    for (const [id, record] of this.#sessions.get(session) ?? []) {
      if (record.view.state === "running") return id;
    }
    return undefined;
  }

  start(session: string, input: GateRunInput): GateView {
    const active = this.active(session);
    if (active !== undefined) throw new Error(`gate: run ${active} is still active`);
    const root = realpathSync(input.root);
    // Match the launcher's runtime_log_path: HOME/.dyfj/log, not DYFJ_ROOT.
    const home = this.#env.get("HOME");
    if (home === undefined || !isAbsolute(home)) throw new Error("gate: runtime logs require an absolute HOME");
    if (!/^[a-zA-Z0-9_-]+$/.test(session)) throw new Error("gate: invalid session id");
    const runtimeRoot = join(realpathSync(home), ".dyfj");
    const rel = relative(root, join(runtimeRoot, "log", "gate", session));
    if (rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../"))) {
      throw new Error("gate: runtime log directory must be outside the workspace");
    }
    const logRoot = join(runtimeRoot, "log");
    const gateRoot = join(logRoot, "gate");
    const directory = join(gateRoot, session);
    for (const path of [runtimeRoot, logRoot, gateRoot, directory]) {
      try { mkdirSync(path, { mode: 0o700 }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const dir = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fchmodSync(dir, 0o700); } finally { closeSync(dir); }
    }
    const run = randomUUID();
    const logPath = join(directory, `${run}.log`);
    const fd = openSync(logPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { fchmodSync(fd, 0o600); } catch (error) { closeSync(fd); throw error; }
    const record: RecordRun = {
      view: { run, state: "running", mode: input.mode, paths: [...input.paths], exitCode: null, statusLine: null, tail: "", logPath },
      abort: new AbortController(), done: Promise.resolve(),
    };
    let records = this.#sessions.get(session);
    if (records === undefined) { records = new Map(); this.#sessions.set(session, records); }
    records.set(run, record);
    // Keep completed history bounded; active runs are never evicted.
    for (const [id, old] of records) {
      if (records.size <= 64) break;
      if (old.view.state !== "running") records.delete(id);
    }
    let tail = Buffer.alloc(0);
    let outputFailure = false;
    const onOutput = (chunk: Uint8Array) => {
      try {
        let offset = 0;
        while (offset < chunk.length) offset += writeSync(fd, chunk, offset, chunk.length - offset);
      } catch { outputFailure = true; record.abort.abort(); }
      tail = Buffer.concat([tail, chunk]).subarray(-TAIL_BYTES);
      // Trim any partial leading UTF-8 character after byte clipping.
      let first = 0;
      while (first < tail.length && (tail[first]! & 0xc0) === 0x80) first++;
      const decoded = tail.subarray(first).toString("utf8");
      record.view.tail = clipToUtf8Bytes(decoded, TAIL_BYTES) ?? decoded;
      const lines = record.view.tail.split(/\r?\n/);
      for (const line of lines) if (line.startsWith("gate-status ")) record.view.statusLine = line;
    };
    const execute = async (): Promise<BoundedResult> => {
      const request = { root, cwd: root, timeoutMs: input.timeoutMs, env: input.env, signal: record.abort.signal, onOutput };
      if (input.sandbox !== undefined) return await input.sandbox.runArgv(input.argv, request);
      const policy = input.policy ?? baseRuntimePolicy();
      return await runBounded({ command: input.argv[0]!, args: input.argv.slice(1), ...request }, {
        policy: { ...policy, run: [...policy.run, input.argv[0]!] },
      });
    };
    record.done = execute().then(result => {
      record.view.exitCode = result.code;
      record.view.state = outputFailure ? "failed" : result.timedOut ? "timed-out"
        : result.cancelled ? "cancelled" : result.code === 0 ? "passed" : "failed";
    }, () => {
      record.view.state = record.abort.signal.aborted && !outputFailure ? "cancelled" : "failed";
    }).finally(() => { closeSync(fd); });
    return this.get(session, run);
  }

  get(session: string, run: string): GateView {
    const view = this.#sessions.get(session)?.get(run)?.view;
    return view === undefined
      ? { run, state: "unknown", mode: null, paths: [], exitCode: null, statusLine: null, tail: "", logPath: null }
      : { ...view, paths: [...view.paths] };
  }

  async wait(session: string, run: string, seconds: number): Promise<GateView> {
    const record = this.#sessions.get(session)?.get(run);
    if (record !== undefined && record.view.state === "running" && seconds > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([record.done, new Promise<void>(resolve => { timer = setTimeout(resolve, seconds * 1000); })]);
      } finally { clearTimeout(timer); }
    }
    return this.get(session, run);
  }

  cancel(session: string, run: string): GateView {
    const record = this.#sessions.get(session)?.get(run);
    if (record?.view.state === "running") record.abort.abort();
    return this.get(session, run);
  }

  async close(): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const [session, records] of this.#sessions) for (const [run, record] of records) {
      this.cancel(session, run); pending.push(record.done);
    }
    await Promise.all(pending);
    this.#sessions.clear();
  }
}
