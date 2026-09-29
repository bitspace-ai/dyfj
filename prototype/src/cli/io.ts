/**
 * The client's I/O ports: the terminal (`Io`), Ctrl-C delivery during a turn
 * (`TurnInterruptSource`) and the socket connector (`ConnectFn`), plus their
 * real adapters. Tests substitute `testing/fakes/fake-io.ts` and a scripted
 * connector.
 */

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

export const denoTurnInterruptSource: TurnInterruptSource = {
  add: (handler) => Deno.addSignalListener("SIGINT", handler),
  remove: (handler) => Deno.removeSignalListener("SIGINT", handler),
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
 * otherwise the REPL's await hangs and Deno reports a never-resolved top-level
 * await instead of exiting cleanly.
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

export function realIo(): Io {
  const encoder = new TextEncoder();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const inputIsTerminal = Deno.stdin.isTerminal();
  const outputIsTerminal = Deno.stdout.isTerminal();
  return {
    out: (text) => {
      Deno.stdout.writeSync(encoder.encode(text));
    },
    err: (line) => console.error(line),
    errRaw: (text) => {
      Deno.stderr.writeSync(encoder.encode(text));
    },
    errIsTerminal: Deno.stderr.isTerminal(),
    readLine: (prompt, signal) => readLineOrNull(rl, prompt, signal),
    turnInterrupts: selectTurnInterruptSource(
      inputIsTerminal,
      outputIsTerminal,
      readlineTurnInterruptSource(rl),
      denoTurnInterruptSource,
    ),
    close: () => rl.close(),
  };
}
