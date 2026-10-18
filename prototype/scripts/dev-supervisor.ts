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
 * - A change that reloads both halves is announced by the new REPL only: the
 *   old one is told it is being replaced (`replaced`) and stays quiet when the
 *   runtime comes back, and the new one is started with the reason and says
 *   `runtime and REPL reloaded (...)`; the supervisor adds no line of its own.
 * - The runtime restarts before the REPL. A runtime that boots on the working
 *   tree becomes the last good code (`dev-snapshot.ts`). One that fails to
 *   boot is replaced by the last good code, with the failure passed to it for
 *   the model to read, and the REPL resumes on it; the next save of any file
 *   tries the working tree again. With no usable last good code, the runtime
 *   stays down and the REPL waits for it, as before.
 * - `/rollback` switches to the last good code on purpose, for a runtime that
 *   starts but fails every turn; `/reload` or a save returns to the tree.
 * - The REPL exiting when nothing asked it to is the operator quitting: the
 *   runtime is stopped and `done` resolves with the REPL's exit code.
 */

import type { BatchClass } from "./dev-classify.ts";
import type { SnapshotCheck } from "./dev-snapshot.ts";

export const DEBOUNCE_MS = 300;
export const IN_FLIGHT_POLL_MS = 250;
const MAX_REPORT_CHARS = 200;

export interface DevClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type Outcome = { ok: true } | { ok: false; error: string };

/** How a runtime start went: the code it reports loading, or why it failed. */
export type StartOutcome =
  | {
    ok: true;
    contentHash?: string | null;
    /** The lock file's hash sampled just before the spawn, for the snapshot record. */
    lockHash?: string;
  }
  | { ok: false; error: string; detail?: string };

/** What the last good code is told, as `DYFJ_DEV_BOOT_FAILURE`, on `/rollback`. */
export const ROLLBACK_NOTE =
  "rolled back by /rollback: the operator switched dyfj dev to the last good " +
  "code. The working tree's runtime started, but it was set aside.";

export interface DevRuntimePort {
  /** Start the working tree's runtime and wait until it answers, or exits. */
  start(): Promise<StartOutcome>;
  /**
   * Start the last good code instead, telling it why (`failure`, the failed
   * start's log or `ROLLBACK_NOTE`), and wait until it answers, or exits.
   */
  startLastGood(failure: string): Promise<StartOutcome>;
  /** Stop the runtime and wait for it to exit; a runtime not running is fine. */
  stop(): Promise<void>;
  /** Turns in flight, or null when the runtime does not answer. */
  inFlightTurns(): Promise<number | null>;
}

export interface DevReplPort {
  /**
   * Start the REPL, resuming `session` when there is one. `reloaded` is the
   * reason when the runtime was reloaded in the same change: the REPL being
   * replaced never saw that reload, so the new one tells the operator.
   */
  launch(session: string | null, reloaded?: string): void;
  /** Ask the REPL to leave as `/quit` does, and wait until it has. */
  exit(): Promise<void>;
  /** Tell the REPL why its runtime is about to restart. */
  notify(message: { type: "reloading"; reason: string; replaced?: boolean }): void;
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
  snapshot: {
    /** Whether the last good code may run now. */
    check(): Promise<SnapshotCheck>;
    /**
     * Make the working tree the last good code, if it is what booted
     * (`contentHash`), recording the lock file it booted on (`lockHash`).
     */
    promote(contentHash: string, lockHash?: string): Promise<Outcome>;
  };
}

/** What the REPL sends the supervisor over its control channel. */
export type ReplMessage =
  | { type: "reload" }
  | { type: "rollback" }
  | { type: "session"; id: string };

interface Pending {
  runtime: boolean;
  repl: boolean;
  /** Switch to the last good code; a later reload of the tree replaces it. */
  rollback: boolean;
  files: Set<string>;
  forced: boolean;
}

const nothingPending = (): Pending => ({
  runtime: false,
  repl: false,
  rollback: false,
  files: new Set(),
  forced: false,
});

/** A snapshot's time, local, to the second. */
export function formatTakenAt(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "time unknown";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

const REFUSED: Record<"corrupt" | "lock", string> = {
  lock: "package-lock.json changed since the last good code, so dyfj dev will not run it. Fix and save to retry.",
  corrupt: "the last good code no longer matches its record, so dyfj dev will not run it. Fix and save to retry.",
};

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
  /** Which code the running runtime loaded. */
  #mode: "tree" | "last-good" = "tree";
  /** This run made a snapshot, so a fallback is not to an earlier run's. */
  #promoted = false;
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
    this.#pending.runtime = message.type === "reload";
    this.#pending.rollback = message.type === "rollback";
    this.#pending.forced = true;
    this.#awaitingSave = false;
    this.#drain();
  }

  /**
   * The first start. A working tree that boots becomes the last good code;
   * one that does not falls back to an earlier run's last good code, when
   * there is one that may run. False when no runtime is up.
   */
  async boot(): Promise<boolean> {
    this.#busy = true;
    try {
      const started = await this.#ports.runtime.start();
      if (started.ok) {
        await this.#promote(started);
        return true;
      }
      const check = await this.#ports.snapshot.check();
      if (!check.ok) {
        this.#ports.report(`the runtime did not start: ${started.error}`);
        if (check.reason !== "none") this.#ports.report(REFUSED[check.reason]);
        return false;
      }
      const fallback = await this.#ports.runtime.startLastGood(started.detail ?? started.error);
      if (!fallback.ok) {
        this.#ports.report(`the runtime did not start: ${started.error}`);
        this.#ports.report(`the last good code did not start either: ${oneLine(fallback.error)}`);
        return false;
      }
      this.#mode = "last-good";
      this.#ports.report(
        "the working tree's runtime failed to start; running the last good code " +
          `from an earlier run (${formatTakenAt(check.meta.takenAt)}). Fix and save to retry.`,
      );
      return true;
    } finally {
      this.#busy = false;
    }
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
    // Down, or on the last good code: any save tries the working tree.
    const runtime = kind.runtime || !this.#runtimeUp || this.#mode === "last-good";
    if (!runtime && !kind.repl) return;
    this.#pending.runtime ||= runtime;
    if (runtime) this.#pending.rollback = false;
    this.#pending.repl ||= kind.repl;
    for (const path of paths) this.#pending.files.add(path);
    this.#awaitingSave = false;
  }

  #drain(): void {
    if (this.#busy || this.#stopping || this.#awaitingSave) return;
    if (this.#poll !== undefined) return;
    if (!this.#pending.runtime && !this.#pending.repl && !this.#pending.rollback) return;
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

    if (job.rollback) {
      await this.#rollback();
      // A REPL rebuild queued before the rollback still happens, next.
      if (job.repl) this.#keep({ ...job, rollback: false, runtime: false }, false);
      return;
    }

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
      // `replaced`: this REPL is about to be replaced, so it stays quiet when
      // the runtime comes back and the new one announces the reload instead.
      ports.repl.notify(
        job.repl ? { type: "reloading", reason, replaced: true } : { type: "reloading", reason },
      );
      if (this.#runtimeUp) await ports.runtime.stop();
      this.#runtimeUp = false;
      if (this.#stopping) return;
      const started = await ports.runtime.start();
      if (this.#stopping) return;
      if (!started.ok) {
        await this.#fallBack(started);
        this.#keep({ ...job, runtime: false });
        return;
      }
      this.#runtimeUp = true;
      await this.#promote(started);
    }

    if (job.repl) {
      this.#replExitExpected = true;
      try {
        await ports.repl.exit();
      } finally {
        this.#replExitExpected = false;
      }
      if (this.#stopping) return;
      if (job.runtime) {
        // One notice for both halves, said by the new REPL (`DYFJ_DEV_RELOADED`).
        ports.repl.launch(this.#session, reason);
      } else {
        ports.repl.launch(this.#session);
        ports.report(`REPL rebuilt (${reason}); started it again`);
      }
    }
  }

  /** The working tree booted: it runs, and becomes the last good code. */
  async #promote(started: { contentHash?: string | null; lockHash?: string }): Promise<void> {
    this.#mode = "tree";
    if (started.contentHash === undefined || started.contentHash === null) {
      this.#ports.report("last good code not updated: the runtime reported no code fingerprint");
      return;
    }
    const promoted = await this.#ports.snapshot.promote(started.contentHash, started.lockHash);
    if (promoted.ok) this.#promoted = true;
    else this.#ports.report(`last good code not updated: ${oneLine(promoted.error)}`);
  }

  /**
   * The working tree's runtime did not start. Run the last good code in its
   * place, told why, when it may run; otherwise stay down until a save.
   */
  async #fallBack(failed: { error: string; detail?: string }): Promise<void> {
    const ports = this.#ports;
    const check = await ports.snapshot.check();
    if (this.#stopping) return;
    if (!check.ok) {
      ports.report(
        check.reason === "none"
          ? `runtime failed to start: ${oneLine(failed.error)}; save a file to try again`
          : `runtime failed to start: ${oneLine(failed.error)}; ${REFUSED[check.reason]}`,
      );
      return;
    }
    ports.report(`runtime failed to start: ${oneLine(failed.error)}`);
    ports.repl.notify({ type: "reloading", reason: "running the last good code" });
    const fallback = await ports.runtime.startLastGood(failed.detail ?? failed.error);
    if (this.#stopping) return;
    if (!fallback.ok) {
      ports.report(
        `the last good code did not start either: ${oneLine(fallback.error)}; ` +
          "save a file to try again",
      );
      return;
    }
    this.#runtimeUp = true;
    this.#mode = "last-good";
    const earlier = this.#promoted ? "" : "from an earlier run ";
    ports.report(
      "the working tree's runtime failed to start; running the last good code " +
        `${earlier}(${formatTakenAt(check.meta.takenAt)}). Fix and save to retry.`,
    );
  }

  /** `/rollback`: run the last good code now, if it may run. */
  async #rollback(): Promise<void> {
    const ports = this.#ports;
    const check = await ports.snapshot.check();
    if (this.#stopping) return;
    if (!check.ok) {
      ports.report(
        check.reason === "none"
          ? "no last good code to roll back to; nothing changed"
          : `not rolled back: ${REFUSED[check.reason].replace(/ Fix and save to retry\.$/, "")}`,
      );
      return;
    }
    ports.repl.notify({ type: "reloading", reason: "rollback requested" });
    if (this.#runtimeUp) await ports.runtime.stop();
    this.#runtimeUp = false;
    if (this.#stopping) return;
    const started = await ports.runtime.startLastGood(ROLLBACK_NOTE);
    if (this.#stopping) return;
    if (!started.ok) {
      ports.report(
        `the last good code did not start: ${oneLine(started.error)}; ` +
          "save a file or /reload to start the working tree's runtime",
      );
      return;
    }
    this.#runtimeUp = true;
    this.#mode = "last-good";
    ports.report(
      `running the last good code (${formatTakenAt(check.meta.takenAt)}); ` +
        "save or /reload to return to the working tree",
    );
  }

  /**
   * Put a job back: by default one that could not finish, to retry on the
   * next save; with `awaitSave` false, one to run next.
   */
  #keep(job: Pending, awaitSave = true): void {
    this.#pending.runtime ||= job.runtime;
    this.#pending.repl ||= job.repl;
    for (const path of job.files) this.#pending.files.add(path);
    this.#awaitingSave ||= awaitSave;
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
