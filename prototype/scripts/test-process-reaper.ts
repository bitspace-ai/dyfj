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
  extraHomes: string[];
  includeDetachedFixtures: boolean;
} {
  let supervisorPid: number | undefined;
  let deadlineEpochSec: number | undefined;
  let tmpDir: string | undefined;
  const extraHomes: string[] = [];
  let includeDetachedFixtures = false;
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
    } else if (arg === "--home") {
      if (next === undefined || next === "") {
        throw new Error("--home requires a path");
      }
      extraHomes.push(next);
      i++;
    } else if (arg === "--include-detached-fixtures") {
      includeDetachedFixtures = true;
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
  return { supervisorPid, deadlineEpochSec, tmpDir, extraHomes, includeDetachedFixtures };
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
