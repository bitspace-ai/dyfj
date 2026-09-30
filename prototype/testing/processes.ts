// Process cleanup for integration tests that start processes they do not own
// as children, such as a runtime the launcher detaches with `nohup`: only a
// scan of the process list finds those. Uses `/bin/ps` and `/bin/kill`, so a
// caller needs run grants for both.

interface ProcessInfo {
  pid: number;
  command: string;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function listProcesses(): Promise<ProcessInfo[]> {
  const output = await new Deno.Command("/bin/ps", {
    args: ["-ax", "-o", "pid=,command="],
    stdout: "piped",
    stderr: "null",
  }).output();
  if (!output.success) return [];
  const processes: ProcessInfo[] = [];
  for (const line of new TextDecoder().decode(output.stdout).split("\n")) {
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
  await new Deno.Command("/bin/kill", {
    args: [signal === "SIGKILL" ? "-KILL" : "-TERM", "--", String(pid)],
    stdout: "null",
    stderr: "null",
  }).output().catch(() => undefined);
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
