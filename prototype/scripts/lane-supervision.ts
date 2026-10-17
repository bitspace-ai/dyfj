// Test-lane supervision shared by the lane runners (the unit, isolated-Dolt
// integration and golden runners) and the aggregate gate
// (`specs/notes/test-supervision-evidence.md`).
//
// The gate starts each test-lane runner as the leader of a process group of
// its own and hands it four values in its environment. Their presence is
// what marks a run as a gate lane; a direct run (`node
// scripts/run-unit-tests.ts` from a terminal) has none of them and supervises
// nothing, because it shares the invoking shell's process group.
//
// - A backstop deadline. The gate enforces its own, shorter deadline; the
//   runner's backstop matters only when the gate itself is gone. On expiry
//   the runner ends the step it is waiting on (the unit and golden runners
//   kill their child by pid, which keeps every process in the lane group the
//   gate owns). A runner still running a bounded time after that stops its
//   group and exits, so a hang in its own awaited work cannot outlive it.
//   The backstop also fires early, the moment the runner's parent is not the
//   gate: a lane whose gate died is ended within a bounded time, not left
//   running to its deadline.
// - A lane token. The runner starts a token carrier: an idle same-group
//   process whose command line ends with the token, from the runner's start
//   until its group is stopped. A later gate run uses it to recognise an
//   orphaned lane group after the gate and the runner were both killed, in
//   whatever step the lane was, without trusting a numeric id alone. The
//   carrier watches its own parent, which must be the runner whose pid names
//   the group: once the runner is gone, even before the carrier started, it
//   stops the group itself and exits, so a lane group does not wait for a
//   later gate run to be recovered.
// - The gate's pid, the parent the runner must have. The runner compares its
//   parent with it, never with a parent it observed itself, so a gate that
//   died before the runner started is seen to be gone too.
// - The deadline itself, for the runner's messages.
//
// When all of its work is done, the runner stops its own process group: TERM,
// which it ignores itself, then, after a bounded wait, KILL to each member
// still running. So a same-group descendant, even one that ignores TERM, does
// not outlive the lane when the gate is no longer there to tear the group
// down.
//
// Every helper here is a `node` child of the runner (`process.execPath`,
// which runs the runner itself), written to `node:` builtins.
import { type ChildProcess, spawn } from "node:child_process";
import process from "node:process";

export const LANE_DEADLINE_ENV = "DYFJ_LANE_DEADLINE_MS";
export const LANE_BACKSTOP_ENV = "DYFJ_LANE_BACKSTOP_MS";
export const LANE_TOKEN_ENV = "DYFJ_LANE_TOKEN";
export const LANE_PARENT_ENV = "DYFJ_LANE_PARENT_PID";
export const LANE_ENV_NAMES = [
  LANE_DEADLINE_ENV,
  LANE_BACKSTOP_ENV,
  LANE_TOKEN_ENV,
  LANE_PARENT_ENV,
] as const;

// How long a runner past its backstop may keep running before it stops its
// group and exits regardless.
export const BACKSTOP_EXIT_GRACE_MS = 30_000;
// How long the group stop waits after TERM before it KILLs what is left.
export const GROUP_STOP_GRACE_MS = 2_000;
// How often the runner and its carrier check that their parent is still the
// one they must have, as the ACP fixture agent's watchdog does. Each also
// checks once as it starts.
export const PARENT_WATCH_INTERVAL_MS = 200;

// The longest delay a timer honours. A longer one fires after about 1 ms
// instead, so a supervision value past it is malformed.
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

const LANE_TOKEN_ARG_PREFIX = "--dyfj-lane=";
const LANE_TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface LaneSupervision {
  deadlineMs: number;
  backstopMs: number;
  token: string;
  /** The gate's pid: the parent this runner must have. */
  parentPid: number;
}

function pathEnvironment(): Record<string, string> {
  const path = process.env.PATH;
  return path === undefined ? {} : { PATH: path };
}

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^[1-9][0-9]{0,9}$/.test(value)) return undefined;
  const parsed = Number(value);
  return parsed <= MAX_TIMER_DELAY_MS ? parsed : undefined;
}

export function isLaneToken(token: string): boolean {
  return LANE_TOKEN_PATTERN.test(token);
}

/** The command-line argument that carries a lane token. */
export function laneTokenArgument(token: string): string {
  return `${LANE_TOKEN_ARG_PREFIX}${token}`;
}

/**
 * The supervision the gate asked for, or undefined for a run the gate did not
 * start. All four values must be present and well formed.
 */
export function laneSupervision(
  read: (name: string) => string | undefined = (name) => process.env[name],
): LaneSupervision | undefined {
  const deadlineMs = positiveInteger(read(LANE_DEADLINE_ENV));
  const backstopMs = positiveInteger(read(LANE_BACKSTOP_ENV));
  const token = read(LANE_TOKEN_ENV);
  const parentPid = positiveInteger(read(LANE_PARENT_ENV));
  if (
    deadlineMs === undefined || backstopMs === undefined ||
    token === undefined || !isLaneToken(token) ||
    parentPid === undefined || parentPid === 1
  ) {
    return undefined;
  }
  return { deadlineMs, backstopMs, token, parentPid };
}

// Shared by the carrier and the group stop, which run it as a module
// (`node --input-type=module -e`). `processRows` lists every process, or
// undefined when `ps` fails. `stopGroup` is the group stop: TERM to the group
// (which the caller ignores, and which leaves a token carrier waiting for the
// caller), then, once only carriers are left or the grace has passed, KILL to
// each member still running, carriers included, by pid, so neither the
// group's leader nor the caller is killed. A zombie counts as gone. The
// caller's own `ps` is not a member to wait for, and a carrier's own `ps`
// counts as part of the carrier. It fails closed: if the last listing within
// the grace failed, nothing says the group is empty, so it reports that on
// stderr and KILLs the whole group, the leader and the caller included.
const GROUP_STOP_FUNCTIONS = `
import { execFile } from "node:child_process";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function processRows() {
  return new Promise((resolve) => {
    execFile("ps", ["-A", "-ww", "-o", "pid=,ppid=,pgid=,stat=,command="], {
      encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024 * 1024,
    }, (error, stdout) => {
      if (error) return resolve(undefined);
      resolve(stdout.split("\\n").flatMap((line) => {
        const match = line.match(/^\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\S+)\\s*(.*)$/);
        if (!match) return [];
        const [, pid, ppid, pgid, stat, command] = match;
        return [{
          pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), stat,
          command,
        }];
      }));
    });
  });
}
async function stopGroup(group, grace, tokenArgument) {
  const spared = new Set([group, process.pid]);
  try { process.kill(-group, "SIGTERM"); } catch { return; }
  async function members() {
    const all = await processRows();
    if (all === undefined) return undefined;
    const rows = all.filter((r) =>
      r.pgid === group && !spared.has(r.pid) && !r.stat.startsWith("Z")
    ).map((r) => ({
      pid: r.pid, ppid: r.ppid, carrier: r.command.endsWith(tokenArgument),
    }));
    const carriers = new Set(rows.filter((r) => r.carrier).map((r) => r.pid));
    return rows.flatMap((r) =>
      r.ppid === process.pid
        ? []
        : [{ pid: r.pid, carrier: r.carrier || carriers.has(r.ppid) }]
    );
  }
  const deadline = Date.now() + grace;
  let left = await members();
  while (
    (left === undefined || left.some((m) => !m.carrier)) &&
    Date.now() < deadline
  ) {
    await sleep(50);
    left = await members();
  }
  if (left === undefined) {
    process.stderr.write(
      "dyfj: the group stop could not list the lane's processes; " +
        "killing the whole lane group\\n",
    );
    try { process.kill(-group, "SIGKILL"); } catch { /* already gone */ }
    return;
  }
  for (const { pid } of left) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
}
`;

// The carrier's program, with the lane group's id (the runner's pid), the
// group stop's grace in ms and the lane token argument as script arguments;
// the token trails the command line, and the program's first line says what
// the process is to anyone reading a process list. On TERM it does not exit
// at once: it waits until nothing but itself and the group's leader is left
// in the group, then exits. So a teardown whose TERM ends the lane's
// processes is not held up by the carrier, while a descendant that ignores
// TERM keeps it, and with it the token, in the group until the teardown's
// KILL. Its parent must be the runner, whose pid names the group: once its
// parent is anything else, whether or not a TERM came first and even before
// the carrier started, the carrier stops the group as the runner would have
// and exits, so neither it nor a descendant that ignores TERM outlives a
// runner that was killed. It checks once at start, then every interval.
const TOKEN_CARRIER_PROGRAM =
  `// dyfj test-lane token carrier: holds its lane's token until the lane's group is empty
${GROUP_STOP_FUNCTIONS}
const group = Number(process.argv[1]);
const grace = Number(process.argv[2]);
const tokenArgument = process.argv[3];
let leaving = false;
let stopping = false;
async function othersLeft() {
  const rows = await processRows();
  if (rows === undefined) return true;
  // Neither this process, its own \`ps\`, nor the group's leader counts.
  return rows.some((r) =>
    r.pgid === group && r.pid !== process.pid && r.ppid !== process.pid &&
    r.pid !== group && !r.stat.startsWith("Z")
  );
}
process.on("SIGTERM", async () => {
  if (leaving || stopping) return;
  leaving = true;
  while (!stopping && await othersLeft()) await sleep(50);
  if (!stopping) process.exit(0);
});
async function watchParent() {
  if (stopping || process.ppid === group) return;
  stopping = true;
  await stopGroup(group, grace, tokenArgument);
  process.exit(0);
}
setInterval(watchParent, ${PARENT_WATCH_INTERVAL_MS});
watchParent();
`;

// Run by a short-lived same-group child, with the runner's pid, the grace in
// ms and the lane token argument as script arguments: the group stop above.
// While the runner is alive it leads the group, so the group id cannot name
// another group; once it has started, its whole job is to end the group,
// whether or not its parent is still there, and it is bounded on its own: it
// exits a fixed margin past the grace whatever `ps` does.
const GROUP_STOP_PROGRAM = `${GROUP_STOP_FUNCTIONS}
process.on("SIGTERM", () => {});
const [runner, grace, tokenArgument] = process.argv.slice(1);
setTimeout(() => process.exit(0), Number(grace) + 10_000).unref();
await stopGroup(Number(runner), Number(grace), tokenArgument);
process.exit(0);
`;

function startHelper(
  program: string,
  args: readonly string[],
  stderr: "ignore" | "inherit",
): ChildProcess {
  return spawn(
    process.execPath,
    ["--input-type=module", "-e", program, ...args],
    // PATH, to find `ps`, and nothing else.
    { env: pathEnvironment(), stdio: ["ignore", "ignore", stderr] },
  );
}

/**
 * Starts the lane's token carrier in this process's group, for a gate lane
 * only and only outside Windows, where neither the group stop nor recovery
 * runs to end it. It runs until the group is stopped, or until this process
 * is gone, and does not keep this process alive.
 */
export function startTokenCarrier(
  supervision: LaneSupervision | undefined,
): void {
  if (supervision === undefined || process.platform === "win32") return;
  const carrier = startHelper(TOKEN_CARRIER_PROGRAM, [
    String(process.pid),
    String(GROUP_STOP_GRACE_MS),
    laneTokenArgument(supervision.token),
  ], "ignore");
  carrier.on("error", () => {});
  carrier.unref();
}

export interface Backstop {
  /** Whether the backstop fired. */
  readonly expired: boolean;
  /** Why it fired: its deadline passed, or this process's parent is gone. */
  readonly reason: "deadline" | "orphaned" | undefined;
  clear(): void;
}

/**
 * Calls `onExpire` once the backstop passes, or as soon as this process's
 * parent is not the gate (`parentPid`), unless cleared first. That is checked
 * once here, so `onExpire` may run before this returns: a runner checks
 * `expired` before each step it starts. Once it has fired, clearing no longer
 * helps: if this process is still running `exitGraceMs` later, it stops its
 * own group and exits 1, whatever it was waiting on.
 */
export function startBackstop(
  supervision: LaneSupervision | undefined,
  onExpire: () => void,
  exitGraceMs = BACKSTOP_EXIT_GRACE_MS,
): Backstop {
  let reason: Backstop["reason"];
  if (supervision === undefined) {
    return { expired: false, reason: undefined, clear() {} };
  }
  const fire = (why: "deadline" | "orphaned") => {
    if (reason !== undefined) return;
    reason = why;
    clearTimeout(timer);
    clearInterval(watch);
    const exit = setTimeout(async () => {
      console.error(
        why === "deadline"
          ? `dyfj: the lane was still running ${exitGraceMs} ms past its backstop deadline (${supervision.backstopMs} ms); stopping it`
          : `dyfj: the lane was still running ${exitGraceMs} ms after its gate exited; stopping it`,
      );
      await stopOwnGroup(supervision);
      process.exit(1);
    }, exitGraceMs);
    // The exit timer never keeps the runner alive on its own.
    exit.unref();
    onExpire();
  };
  const timer = setTimeout(() => fire("deadline"), supervision.backstopMs);
  const watchParent = () => {
    if (process.ppid !== supervision.parentPid) fire("orphaned");
  };
  const watch = setInterval(watchParent, PARENT_WATCH_INTERVAL_MS);
  // The watch never keeps the runner alive on its own.
  watch.unref();
  watchParent();
  return {
    get expired() {
      return reason !== undefined;
    },
    get reason() {
      return reason;
    },
    clear() {
      clearTimeout(timer);
      clearInterval(watch);
    },
  };
}

/** The runner's message for a backstop that fired, naming its lane. */
export function backstopMessage(
  lane: string,
  supervision: LaneSupervision,
  backstop: Backstop,
): string {
  return backstop.reason === "orphaned"
    ? `dyfj: ${lane} stopped because its gate exited`
    : `dyfj: ${lane} passed its backstop deadline (${supervision.backstopMs} ms)`;
}

/** Kills a child by pid, ignoring one that already exited. */
export function killChild(child: ChildProcess): void {
  try {
    child.kill("SIGKILL");
  } catch {
    // Already exited.
  }
}

/**
 * Stops this process's own group once the lane's work is done: TERM, which
 * this process ignores, then KILL to whatever is left after
 * `GROUP_STOP_GRACE_MS`. Only a gate lane does this, and only outside
 * Windows. A short-lived child carries the signals, so it can wait out the
 * grace while this process ignores TERM. If this process does not lead a
 * group, the signal names no group and reaches nothing.
 */
export async function stopOwnGroup(
  supervision: LaneSupervision | undefined,
): Promise<void> {
  if (supervision === undefined || process.platform === "win32") return;
  // Stays installed: the runner exits right after this.
  process.on("SIGTERM", () => {});
  await new Promise<void>((resolve) => {
    let stopper: ChildProcess;
    try {
      // Its stderr is the lane's: a failed listing is reported there.
      stopper = startHelper(GROUP_STOP_PROGRAM, [
        String(process.pid),
        String(GROUP_STOP_GRACE_MS),
        laneTokenArgument(supervision.token),
      ], "inherit");
    } catch {
      // Best effort: the gate's own teardown remains when it is alive.
      resolve();
      return;
    }
    stopper.on("error", () => resolve());
    stopper.on("exit", () => resolve());
  });
}
