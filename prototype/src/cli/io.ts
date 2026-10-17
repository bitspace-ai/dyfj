/**
 * The client's I/O ports: the terminal (`Io`), Ctrl-C delivery during a turn
 * (`TurnInterruptSource`) and the socket connector (`ConnectFn`), plus their
 * real adapters. Tests substitute `testing/fakes/fake-io.ts` and a scripted
 * connector.
 */

import { writeSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import process from "node:process";
import type { connectUnixClient } from "../transport/mod.ts";

export interface Io {
  /** Write to stdout with no implicit newline (used for streaming deltas). */
  out(text: string): void;
  /** Write a line to stderr (status, receipts, errors). */
  err(line: string): void;
  /** Write to stderr with no implicit newline (spinner frames). Optional. */
  errRaw?(text: string): void;
  /** True when stderr is an interactive terminal (spinner may animate). */
  errIsTerminal?: boolean;
  /** Prompt and read one line; null on EOF. */
  readLine(prompt: string, signal?: AbortSignal): Promise<string | null>;
  /** Interactive readline owns terminal Ctrl-C while its interface is open. */
  turnInterrupts?: TurnInterruptSource;
  close(): void;
}

export type ConnectFn = typeof connectUnixClient;

export interface TurnInterruptSource {
  add(handler: () => void): void;
  remove(handler: () => void): void;
}

export const processSigintSource: TurnInterruptSource = {
  add: (handler) => {
    process.on("SIGINT", handler);
  },
  remove: (handler) => {
    process.off("SIGINT", handler);
  },
};

interface QuestionReadline {
  question(prompt: string, options?: { signal?: AbortSignal }): Promise<string>;
  once(event: "close", listener: () => void): unknown;
  off(event: "close", listener: () => void): unknown;
}

interface SigintReadline {
  on(event: "SIGINT", listener: () => void): unknown;
  off(event: "SIGINT", listener: () => void): unknown;
}

export function readlineTurnInterruptSource(
  rl: SigintReadline,
): TurnInterruptSource {
  return {
    add: (handler) => {
      rl.on("SIGINT", handler);
    },
    remove: (handler) => {
      rl.off("SIGINT", handler);
    },
  };
}

export function selectTurnInterruptSource(
  inputIsTerminal: boolean,
  outputIsTerminal: boolean,
  readlineSource: TurnInterruptSource,
  signalSource: TurnInterruptSource,
): TurnInterruptSource | undefined {
  if (!inputIsTerminal) return undefined;
  return outputIsTerminal ? readlineSource : signalSource;
}

/**
 * Read one line, resolving null on EOF. On Ctrl-D readline emits "close" but the
 * pending `question` promise never settles, so race it against "close" —
 * otherwise the REPL's await hangs and the runtime reports a never-resolved
 * top-level await instead of exiting cleanly.
 */
export function readLineOrNull(
  rl: QuestionReadline,
  prompt: string,
  signal?: AbortSignal,
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const onClose = () => resolve(null);
    rl.once("close", onClose);
    rl.question(prompt, signal === undefined ? undefined : { signal }).then(
      (answer) => {
        rl.off("close", onClose);
        resolve(answer);
      },
      () => {
        rl.off("close", onClose);
        resolve(null);
      },
    );
  });
}

/** Write `length` bytes of `bytes` from `offset` to `fd`; returns the count written. */
export type FdWriter = (
  fd: number,
  bytes: Uint8Array,
  offset: number,
  length: number,
) => number;

const pauseCell = new Int32Array(new SharedArrayBuffer(4));
const EAGAIN_PAUSE_MS = 5;

function pauseBriefly(): void {
  Atomics.wait(pauseCell, 0, 0, EAGAIN_PAUSE_MS);
}

/**
 * Write every byte of `bytes` to `fd` synchronously. One `writeSync` may write
 * fewer bytes than asked (a slow pipe under Node writes one pipe buffer), and a
 * non-blocking descriptor may report EAGAIN; either way, wait briefly and write
 * the rest.
 */
export function writeAll(
  fd: number,
  bytes: Uint8Array,
  write: FdWriter = writeSync,
  pause: () => void = pauseBriefly,
): void {
  let offset = 0;
  while (offset < bytes.length) {
    let written: number;
    try {
      written = write(fd, bytes, offset, bytes.length - offset);
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== "EAGAIN") throw error;
      written = 0;
    }
    if (written === 0) pause();
    offset += written;
  }
}

const lineEncoder = new TextEncoder();

/**
 * Write `line` and a newline to `fd` through `writeAll`. `console.error` is
 * asynchronous on a POSIX pipe under Node, so an immediate `process.exit`
 * could drop the end of a long line.
 */
export function writeLine(
  fd: number,
  line: string,
  write: FdWriter = writeSync,
  pause: () => void = pauseBriefly,
): void {
  writeAll(fd, lineEncoder.encode(`${line}\n`), write, pause);
}

/**
 * A readline interface created on first use. On a terminal, creating one puts
 * the TTY in raw mode (no signals from Ctrl-C) until it closes, so a command
 * that never reads must never create one. `dyfj start` did, and the runtime it
 * spawned with inherited stdio recorded the raw mode as its startup state and
 * restored it on exit, leaving the terminal unable to send SIGINT (BIT-686).
 */
export function lazyReadline<
  T extends SigintReadline & { close(): void },
>(create: () => T): {
  open(): T;
  /** SIGINT listeners; adding one opens the interface, removing one never does. */
  sigint: SigintReadline;
  close(): void;
} {
  let rl: T | undefined;
  const open = () => rl ??= create();
  return {
    open,
    sigint: {
      on: (event, listener) => open().on(event, listener),
      off: (event, listener) => rl?.off(event, listener),
    },
    close: () => rl?.close(),
  };
}

export function realIo(): Io {
  const encoder = new TextEncoder();
  const terminal = lazyReadline(() =>
    createInterface({ input: process.stdin, output: process.stdout })
  );
  const inputIsTerminal = process.stdin.isTTY === true;
  const outputIsTerminal = process.stdout.isTTY === true;
  return {
    out: (text) => {
      writeAll(process.stdout.fd, encoder.encode(text));
    },
    err: (line) => writeLine(process.stderr.fd, line),
    errRaw: (text) => {
      writeAll(process.stderr.fd, encoder.encode(text));
    },
    errIsTerminal: process.stderr.isTTY === true,
    readLine: (prompt, signal) =>
      readLineOrNull(terminal.open(), prompt, signal),
    turnInterrupts: selectTurnInterruptSource(
      inputIsTerminal,
      outputIsTerminal,
      readlineTurnInterruptSource(terminal.sigint),
      processSigintSource,
    ),
    close: () => terminal.close(),
  };
}
