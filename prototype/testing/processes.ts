// Process cleanup for integration tests that start processes they do not own
// as children, such as a runtime the launcher detaches with `nohup`: only a
// scan of the process list finds those. Uses `/bin/ps` and `/bin/kill`, so a
// caller needs run grants for both.

import { execFile } from "node:child_process";

interface ProcessInfo {
  pid: number;
  command: string;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs `file`; resolves with its stdout, or `undefined` if it failed. */
function run(file: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      // An explicit, empty environment: copying the process's own would
      // need a grant for every variable in it.
      { encoding: "utf8", env: {}, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => resolve(error === null ? stdout : undefined),
    );
  });
}

async function listProcesses(): Promise<ProcessInfo[]> {
  const output = await run("/bin/ps", ["-ax", "-o", "pid=,command="]);
  if (output === undefined) return [];
  const processes: ProcessInfo[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (match) processes.push({ pid: Number(match[1]), command: match[2] });
  }
  return processes;
}

async function killPid(
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  await run("/bin/kill", [
    signal === "SIGKILL" ? "-KILL" : "-TERM",
    "--",
    String(pid),
  ]);
}

/**
 * Sends TERM, then after `graceMs` KILL, to each of `pids` and to every
 * process whose command line contains `needle` (skipped when empty).
 */
export async function reapPidsAndCommandsContaining(
  pids: number[],
  needle: string,
  opts: { graceMs?: number } = {},
): Promise<void> {
  const targets = new Set(
    pids.filter((pid) => Number.isSafeInteger(pid) && pid > 1),
  );
  if (needle !== "") {
    for (const proc of await listProcesses()) {
      if (proc.command.includes(needle)) targets.add(proc.pid);
    }
  }
  for (const pid of targets) await killPid(pid, "SIGTERM");
  await delay(opts.graceMs ?? 200);
  for (const pid of targets) await killPid(pid, "SIGKILL");
}

/** A process and its parent, from one scan of the process list. */
export interface ProcessNode {
  pid: number;
  ppid: number;
  command: string;
}

/** Every process with its parent pid; empty if `/bin/ps` fails. */
export async function listProcessTree(): Promise<ProcessNode[]> {
  const output = await run("/bin/ps", ["-ax", "-o", "pid=,ppid=,command="]);
  if (output === undefined) return [];
  const nodes: ProcessNode[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (match) {
      nodes.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        command: match[3],
      });
    }
  }
  return nodes;
}

/**
 * The processes whose command line contains `needle`, and every descendant
 * of theirs, from one scan.
 */
export async function processTreeContaining(
  needle: string,
): Promise<ProcessNode[]> {
  const nodes = await listProcessTree();
  const found = new Map<number, ProcessNode>();
  for (const node of nodes) {
    if (node.command.includes(needle)) found.set(node.pid, node);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of nodes) {
      if (!found.has(node.pid) && found.has(node.ppid)) {
        found.set(node.pid, node);
        grew = true;
      }
    }
  }
  return [...found.values()];
}
