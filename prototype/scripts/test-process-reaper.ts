import { runReaper } from "./test-process-harness.ts";

function requiredNumber(flag: string, value: string | undefined): number {
  if (value === undefined || !/^[1-9][0-9]{0,9}$/.test(value)) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return Number(value);
}

function parseArgs(args: string[]): {
  supervisorPid: number;
  deadlineEpochSec: number;
  tmpDir: string;
  commandNeedles: string[];
  lockFile?: string;
  expectedGeneration?: string;
} {
  let supervisorPid: number | undefined;
  let deadlineEpochSec: number | undefined;
  let tmpDir: string | undefined;
  let lockFile: string | undefined;
  let expectedGeneration: string | undefined;
  const commandNeedles: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "--supervisor-pid") {
      supervisorPid = requiredNumber(arg, next);
      i++;
    } else if (arg === "--deadline-epoch") {
      deadlineEpochSec = requiredNumber(arg, next);
      i++;
    } else if (arg === "--tmp-dir") {
      if (next === undefined || next === "") {
        throw new Error("--tmp-dir requires a path");
      }
      tmpDir = next;
      i++;
    } else if (arg === "--lock-file") {
      if (next === undefined || next === "") {
        throw new Error("--lock-file requires a path");
      }
      lockFile = next;
      i++;
    } else if (arg === "--generation") {
      if (next === undefined || next === "") {
        throw new Error("--generation requires a value");
      }
      expectedGeneration = next;
      i++;
    } else if (arg === "--command-needle") {
      if (next === undefined || next === "") {
        throw new Error("--command-needle requires a value");
      }
      commandNeedles.push(next);
      i++;
    } else if (arg === "--home" || arg === "--include-detached-fixtures") {
      throw new Error(
        `${arg} is no longer accepted; cleanup is run-scoped via --tmp-dir and --command-needle`,
      );
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (supervisorPid === undefined) {
    throw new Error("--supervisor-pid is required");
  }
  if (deadlineEpochSec === undefined) {
    throw new Error("--deadline-epoch is required");
  }
  if (tmpDir === undefined) {
    throw new Error("--tmp-dir is required");
  }
  return {
    supervisorPid,
    deadlineEpochSec,
    tmpDir,
    commandNeedles,
    lockFile,
    expectedGeneration,
  };
}

if (import.meta.main) {
  try {
    const opts = parseArgs(Deno.args);
    Deno.exit(await runReaper(opts));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`dyfj test reaper: ${message}`);
    Deno.exit(2);
  }
}
