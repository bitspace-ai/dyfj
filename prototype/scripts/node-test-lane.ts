// The shared `node --test` runner of the unit, integration and golden lanes
// (decision D32, `specs/03-testing.md` §6). Each lane runner checks its
// discovered files with `nodeTestFiles` (`test-files.ts`), and every one runs
// here, under `node --test` with one process per file and the per-file handle
// check preloaded (`testing/node-handle-check.ts`).
//
// The run's TAP stream is passed through to the lane's output and its closing
// summary is parsed, so the lane prints a count line for its files. TAP is Node's stable, documented line format,
// and its summary (`# tests`, `# pass`, `# fail`, ...) is the aggregate the
// runner computes across files. Reading it from the stream needs no reporter
// module of our own and no second output file. A run that exits zero without
// a summary fails, so the Node count cannot drop out of a lane's output
// unnoticed.
//
// Written to `node:` builtins only, so it adds nothing to the runtime.neutral
// ratchet.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import process from "node:process";

/** The Node major `.node-version` pins (decision D32). */
export const NODE_MAJOR = 26;

export const HANDLE_CHECK_URL = new URL(
  "../testing/node-handle-check.ts",
  import.meta.url,
).href;

/**
 * Why `version` (the output of `node --version`, or undefined when `node`
 * could not be run) cannot run the Node lanes, or undefined when it can.
 */
export function nodeVersionProblem(
  version: string | undefined,
): string | undefined {
  const install = `install Node ${NODE_MAJOR} (CI pins 26.11.1) and put ` +
    "`node` on PATH";
  if (version === undefined) {
    return `dyfj: the Node test path needs \`node\` on PATH, and none ran; ${install}`;
  }
  const match = /^v(\d+)\.\d+\.\d+/.exec(version.trim());
  if (match === null || Number(match[1]) !== NODE_MAJOR) {
    return `dyfj: the Node test path needs Node ${NODE_MAJOR}, but \`node ` +
      `--version\` reported ${JSON.stringify(version.trim())}; ${install}`;
  }
  return undefined;
}

/** Throws with an actionable message unless `node` is Node 26. */
export function requireNode(
  readVersion: () => string | undefined = () => {
    try {
      // An explicit environment: with none, `node:child_process` copies
      // every variable, which a lane's grant of named variables forbids.
      return execFileSync("node", ["--version"], {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "" },
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return undefined;
    }
  },
): void {
  const problem = nodeVersionProblem(readVersion());
  if (problem !== undefined) throw new Error(problem);
}

/** The parallelism a parallel lane asks of `node --test`. */
export function parallelJobs(): number {
  return availableParallelism();
}

/**
 * A test-name filter as `node --test` takes it: a `/pattern/` is a regular
 * expression, and anything else matches as a literal substring, as the
 * `--filter` of `test:file` does on the existing runner.
 */
export function nameFilterPattern(filter: string): string {
  if (filter.length > 1 && filter.startsWith("/") && filter.endsWith("/")) {
    return filter.slice(1, -1);
  }
  return filter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function nodeTestArgs(
  files: readonly string[],
  options: { jobs: number; filter?: string },
): string[] {
  return [
    "--test",
    `--import=${HANDLE_CHECK_URL}`,
    `--test-concurrency=${options.jobs}`,
    "--test-reporter=tap",
    ...(options.filter === undefined
      ? []
      : [`--test-name-pattern=${nameFilterPattern(options.filter)}`]),
    ...files,
  ];
}

export interface NodeTestSummary {
  tests: number;
  suites: number;
  pass: number;
  fail: number;
  cancelled: number;
  skipped: number;
  todo: number;
}

const SUMMARY_KEYS = [
  "tests",
  "suites",
  "pass",
  "fail",
  "cancelled",
  "skipped",
  "todo",
] as const;

/**
 * The run's closing summary from a TAP stream: the last unindented
 * `# <key> <n>` line of each key. Undefined unless every key is present.
 * Nested subtests are indented, so their lines never match.
 */
export function parseTapSummary(tap: string): NodeTestSummary | undefined {
  const found = new Map<string, number>();
  for (const line of tap.split("\n")) {
    const match = /^# (\w+) (\d+)$/.exec(line.trimEnd());
    if (match !== null) found.set(match[1], Number(match[2]));
  }
  const summary: Partial<NodeTestSummary> = {};
  for (const key of SUMMARY_KEYS) {
    const value = found.get(key);
    if (value === undefined) return undefined;
    summary[key] = value;
  }
  return summary as NodeTestSummary;
}

/** The lane's count line for its Node files. */
export function formatNodeSummary(
  lane: string,
  files: number,
  summary: NodeTestSummary,
): string {
  const verdict = summary.fail === 0 && summary.cancelled === 0
    ? "ok"
    : "FAILED";
  return `${lane} node --test: ${verdict} | ${summary.pass} passed | ` +
    `${summary.fail} failed | ${summary.skipped} skipped | ` +
    `${summary.todo} todo | ${summary.cancelled} cancelled ` +
    `(${summary.tests} tests, ${summary.suites} suites, ${files} files)`;
}

export interface NodeTestRun {
  /** Ends the run: SIGKILL to `node --test`, for a runner's backstop. */
  kill(): void;
  /** The run's exit code, once its output is drained and counted. */
  code: Promise<number>;
}

export interface NodeTestOptions {
  /** The lane's name in its count lines (`test.unit`, ...). */
  lane: string;
  files: readonly string[];
  cwd: string;
  /** The whole environment of `node --test`; nothing else is inherited. */
  env: Record<string, string>;
  jobs: number;
  filter?: string;
  /** Logs the count lines; the TAP stream goes to the process's stdout. */
  log?: (line: string) => void;
  /** Writes the passed-through TAP stream. */
  write?: (chunk: Uint8Array | string) => void;
}

/**
 * Runs `files` under `node --test`. An empty list is skipped and reported as
 * `0 files`. The child stays in the caller's process group, so a lane's
 * deadline and group stop reach every per-file process it starts.
 */
export function startNodeTests(options: NodeTestOptions): NodeTestRun {
  const log = options.log ?? ((line: string) => console.log(line));
  const write = options.write ??
    ((chunk: Uint8Array | string) => process.stdout.write(chunk));
  if (options.files.length === 0) {
    log(`${options.lane} node --test: 0 files`);
    return { kill() {}, code: Promise.resolve(0) };
  }
  let child: ChildProcess;
  try {
    child = spawn(
      "node",
      nodeTestArgs(options.files, {
        jobs: options.jobs,
        filter: options.filter,
      }),
      {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
  } catch (error) {
    log(`${options.lane} node --test: could not start: ${String(error)}`);
    return { kill() {}, code: Promise.resolve(1) };
  }
  let tail = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    write(chunk);
    tail = (tail + chunk).slice(-16_384);
  });
  const code = new Promise<number>((resolve) => {
    child.on("error", (error) => {
      log(`${options.lane} node --test: could not start: ${error.message}`);
      resolve(1);
    });
    child.on("close", (exitCode) => {
      const summary = parseTapSummary(tail);
      if (summary === undefined) {
        log(
          `${options.lane} node --test: no TAP summary (exit ${exitCode}); ` +
            "the run's count is unknown, so the lane fails",
        );
        resolve(exitCode === 0 || exitCode === null ? 1 : exitCode);
        return;
      }
      log(formatNodeSummary(options.lane, options.files.length, summary));
      resolve(exitCode ?? 1);
    });
  });
  return {
    kill() {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already exited.
      }
    },
    code,
  };
}
