/**
 * Worker that does nothing but run a regular expression over lines of text.
 *
 * It exists for one reason: a Worker can be TERMINATED. A JavaScript `RegExp`
 * backtracks, and a single `test()` call cannot be interrupted once it starts —
 * no timer, signal, or cancellation token will stop it. So the only way to put
 * a wall clock on a pattern we did not write is to run it somewhere we are
 * willing to kill. See bounded-regex.ts for the host side.
 *
 * Keep this module free of I/O. It inherits the host's permissions (Deno's
 * per-worker permission option is still unstable), so its safety rests on doing
 * nothing but string matching, not on a sandbox.
 */

interface MatchRequest {
  id: number;
  pattern: string;
  lines: string[];
}

let compiled: { pattern: string; re: RegExp } | null = null;

self.onmessage = (event: MessageEvent<MatchRequest>) => {
  const { id, pattern, lines } = event.data;
  try {
    if (compiled === null || compiled.pattern !== pattern) {
      compiled = { pattern, re: new RegExp(pattern) };
    }
    const { re } = compiled;
    const hits: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      // `lastIndex` is not carried between calls: the pattern is compiled
      // without /g, so `test` always starts at 0.
      if (re.test(lines[i])) hits.push(i);
    }
    (self as unknown as Worker).postMessage({ id, hits });
  } catch (err) {
    (self as unknown as Worker).postMessage({
      id,
      error: (err as Error).message,
    });
  }
};
