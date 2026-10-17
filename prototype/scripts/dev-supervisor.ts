/**
 * The `dyfj dev` supervisor: turns saved files into runtime restarts and REPL
 * re-execs, at a time that does not cut a turn short.
 *
 * It is the single writer of the dev loop's state. Every input arrives as a
 * method call (a save from the watcher, a message or an exit from the REPL, a
 * runtime exit, a shutdown signal) and every effect goes out through a port,
 * so a test drives it on a fake clock with no process started.
 *
 * - Saves are debounced: one batch, `DEBOUNCE_MS` after the last save.
 * - A batch is classified (`dev-classify.ts`) and merged into the pending
 *   reload. A reload waits while the runtime reports a turn in flight, polling
 *   every `IN_FLIGHT_POLL_MS`; `/reload` skips the wait.
 * - A REPL change is built first. A build failure applies nothing: the REPL
 *   and the runtime keep running, the error is shown on one line, and the
 *   reload stays pending for the next save.
 * - The runtime restarts before the REPL. A runtime that fails to boot stays
 *   down and the REPL waits for it; the next save of any file starts it again.
 * - The REPL exiting when nothing asked it to is the operator quitting: the
 *   runtime is stopped and `done` resolves with the REPL's exit code.
 */

import type { BatchClass } from "./dev-classify.ts";

export const DEBOUNCE_MS = 300;
export const IN_FLIGHT_POLL_MS = 250;
const MAX_REPORT_CHARS = 200;

export interface DevClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type Outcome = { ok: true } | { ok: false; error: string };

export interface DevRuntimePort {
  /** Start the runtime and wait until it answers, or until it exits. */
  start(): Promise<Outcome>;
  /** Stop the runtime and wait for it to exit; a runtime not running is fine. */
  stop(): Promise<void>;
  /** Turns in flight, or null when the runtime does not answer. */
  inFlightTurns(): Promise<number | null>;
}

export interface DevReplPort {
  /** Start the REPL, resuming `session` when there is one. */
  launch(session: string | null): void;
  /** Ask the REPL to leave as `/quit` does, and wait until it has. */
  exit(): Promise<void>;
  /** Tell the REPL why its runtime is about to restart. */
  notify(message: { type: "reloading"; reason: string }): void;
}

export interface DevPorts {
  clock: DevClock;
  classify(paths: readonly string[]): BatchClass;
  runtime: DevRuntimePort;
  repl: DevReplPort;
  /** Build the REPL (`cargo build -p dyfj-repl`). */
  build(): Promise<Outcome>;
  /** Show one line to the operator. */
  report(line: string): void;
}

/** What the REPL sends the supervisor over its control channel. */
export type ReplMessage =
  | { type: "reload" }
  | { type: "session"; id: string };

interface Pending {
  runtime: boolean;
  repl: boolean;
  files: Set<string>;
  forced: boolean;
}

const nothingPending = (): Pending => ({
  runtime: false,
  repl: false,
  files: new Set(),
  forced: false,
});

/** The line of a multi-line error that says what failed, capped. */
export function oneLine(error: string): string {
  const lines = error.split("\n").map((line) => line.trim()).filter(Boolean);
  const line = lines.find((l) => /^error\b/.test(l)) ?? lines[0] ?? "unknown error";
  const visible = line.replace(/[\u0000-\u001f\u007f]/g, "?");
  return visible.length > MAX_REPORT_CHARS
    ? `${visible.slice(0, MAX_REPORT_CHARS)}…`
    : visible;
}

function reasonFor(job: Pending): string {
  const n = job.files.size;
  if (n === 0) return "reload requested";
  return `${n} ${n === 1 ? "file" : "files"} changed`;
}

export class DevSupervisor {
  readonly #ports: DevPorts;
  readonly done: Promise<number>;
  #resolveDone!: (code: number) => void;

  #batch = new Set<string>();
  #debounce: unknown;
  #poll: unknown;
  #pending = nothingPending();
  #runtimeUp = true;
  #session: string | null = null;
  #busy = false;
  /** A build or boot failed; nothing is retried until the next save. */
  #awaitingSave = false;
  /** The REPL exit in progress is one this supervisor asked for. */
  #replExitExpected = false;
  #stopping = false;
  #exitCode = 0;
  #replGone = false;

  constructor(ports: DevPorts) {
    this.#ports = ports;
    this.done = new Promise((resolve) => (this.#resolveDone = resolve));
  }

  /** A file under a watched tree was saved (repo-relative path). */
  changed(path: string): void {
    if (this.#stopping) return;
    this.#batch.add(path);
    if (this.#debounce !== undefined) this.#ports.clock.clearTimeout(this.#debounce);
    this.#debounce = this.#ports.clock.setTimeout(() => {
      this.#debounce = undefined;
      this.#flush();
      this.#drain();
    }, DEBOUNCE_MS);
  }

  replMessage(message: ReplMessage): void {
    if (this.#stopping) return;
    if (message.type === "session") {
      this.#session = message.id;
      return;
    }
    if (this.#debounce !== undefined) {
      this.#ports.clock.clearTimeout(this.#debounce);
      this.#debounce = undefined;
    }
    this.#flush();
    this.#pending.runtime = true;
    this.#pending.forced = true;
    this.#awaitingSave = false;
    this.#drain();
  }

  /** The runtime process exited. Exits during a restart are expected. */
  runtimeExited(code: number | null): void {
    if (this.#stopping || this.#busy) return;
    this.#runtimeUp = false;
    this.#ports.report(
      `runtime exited (${code === null ? "signal" : `code ${code}`}); ` +
        "save a file or /reload to start it again",
    );
  }

  /** The REPL process exited. */
  replExited(code: number): void {
    if (this.#replExitExpected) return;
    this.#replGone = true;
    this.#beginShutdown(code);
  }

  /** A signal asked the supervisor to stop. */
  shutdown(): void {
    this.#beginShutdown(0);
  }

  #flush(): void {
    if (this.#batch.size === 0) return;
    const paths = [...this.#batch].sort();
    this.#batch.clear();
    const kind = this.#ports.classify(paths);
    const runtime = kind.runtime || !this.#runtimeUp;
    if (!runtime && !kind.repl) return;
    this.#pending.runtime ||= runtime;
    this.#pending.repl ||= kind.repl;
    for (const path of paths) this.#pending.files.add(path);
    this.#awaitingSave = false;
  }

  #drain(): void {
    if (this.#busy || this.#stopping || this.#awaitingSave) return;
    if (this.#poll !== undefined) return;
    if (!this.#pending.runtime && !this.#pending.repl) return;
    this.#busy = true;
    void this.#apply().finally(() => {
      this.#busy = false;
      if (this.#stopping) {
        void this.#finishShutdown();
        return;
      }
      this.#drain();
    });
  }

  async #apply(): Promise<void> {
    const ports = this.#ports;
    if (!this.#pending.forced && this.#runtimeUp) {
      const inFlight = await ports.runtime.inFlightTurns();
      if (this.#stopping) return;
      if (inFlight !== null && inFlight > 0 && !this.#pending.forced) {
        this.#poll = ports.clock.setTimeout(() => {
          this.#poll = undefined;
          this.#drain();
        }, IN_FLIGHT_POLL_MS);
        return;
      }
    }
    const job = this.#pending;
    this.#pending = nothingPending();
    const reason = reasonFor(job);

    if (job.repl) {
      const built = await ports.build();
      if (this.#stopping) return;
      if (!built.ok) {
        ports.report(`REPL build failed: ${oneLine(built.error)}`);
        this.#keep(job);
        return;
      }
    }

    if (job.runtime) {
      ports.repl.notify({ type: "reloading", reason });
      if (this.#runtimeUp) await ports.runtime.stop();
      this.#runtimeUp = false;
      if (this.#stopping) return;
      const started = await ports.runtime.start();
      if (this.#stopping) return;
      if (!started.ok) {
        ports.report(
          `runtime failed to start: ${oneLine(started.error)}; ` +
            "save a file to try again",
        );
        this.#keep({ ...job, runtime: false });
        return;
      }
      this.#runtimeUp = true;
    }

    if (job.repl) {
      this.#replExitExpected = true;
      try {
        await ports.repl.exit();
      } finally {
        this.#replExitExpected = false;
      }
      if (this.#stopping) return;
      ports.repl.launch(this.#session);
      ports.report(`REPL rebuilt (${reason}); started it again`);
    }
  }

  /** Put a job that could not finish back, to retry on the next save. */
  #keep(job: Pending): void {
    this.#pending.runtime ||= job.runtime;
    this.#pending.repl ||= job.repl;
    for (const path of job.files) this.#pending.files.add(path);
    this.#awaitingSave = true;
  }

  #beginShutdown(code: number): void {
    if (this.#stopping) return;
    this.#stopping = true;
    this.#exitCode = code;
    for (const timer of [this.#debounce, this.#poll]) {
      if (timer !== undefined) this.#ports.clock.clearTimeout(timer);
    }
    this.#debounce = undefined;
    this.#poll = undefined;
    if (!this.#busy) void this.#finishShutdown();
  }

  async #finishShutdown(): Promise<void> {
    try {
      if (!this.#replGone) {
        this.#replExitExpected = true;
        await this.#ports.repl.exit();
      }
    } finally {
      await this.#ports.runtime.stop();
      this.#resolveDone(this.#exitCode);
    }
  }
}
