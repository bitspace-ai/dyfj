// Test fake for the CLI's terminal I/O (`Io` in `src/cli.ts`).
//
// Output is captured per stream; `readLine` answers from a scripted queue
// and records every prompt it was asked, returning null (EOF) once the queue
// is empty or when the read's signal is already aborted.
import type { Io } from "../../src/cli.ts";

export interface FakeIoOptions {
  errIsTerminal?: boolean;
}

export interface FakeIo {
  io: Io;
  /** `io.out` writes, in order. */
  stdout: string[];
  /** `io.err` lines, in order. */
  stderr: string[];
  /** `io.errRaw` writes, in order. */
  raw: string[];
  /** Prompts passed to `io.readLine`, in order. */
  prompts: string[];
  /** Number of `io.close` calls. */
  readonly closed: number;
}

export function fakeIo(
  lines: readonly string[] = [],
  options: FakeIoOptions = {},
): FakeIo {
  const queue = [...lines];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const raw: string[] = [];
  const prompts: string[] = [];
  let closed = 0;
  const io: Io = {
    out: (text) => stdout.push(text),
    err: (line) => stderr.push(line),
    errRaw: (text) => raw.push(text),
    errIsTerminal: options.errIsTerminal,
    readLine: (prompt, signal) => {
      prompts.push(prompt);
      // Like the real adapter, an aborted read resolves null (and leaves the
      // scripted answer for the next read).
      if (signal?.aborted) return Promise.resolve(null);
      return Promise.resolve(queue.length ? queue.shift()! : null);
    },
    close: () => {
      closed += 1;
    },
  };
  return {
    io,
    stdout,
    stderr,
    raw,
    prompts,
    get closed() {
      return closed;
    },
  };
}
