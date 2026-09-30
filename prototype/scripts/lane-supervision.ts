// Test-lane supervision shared by the lane runners (the unit, isolated-Dolt
// integration and golden runners) and the aggregate gate
// (`specs/notes/test-supervision-evidence.md`).
//
// The gate starts each test-lane runner as the leader of a process group of
// its own and hands it three values in its environment. Their presence is
// what marks a run as a gate lane; a direct run (`deno task test:unit` from a
// terminal) has none of them and supervises nothing, because it shares the
// invoking shell's process group.
//
// - A backstop deadline. The gate enforces its own, shorter deadline; the
//   runner's backstop matters only when the gate itself is gone. On expiry
//   the runner ends the step it is waiting on (the unit and golden runners
//   kill their child by pid, which keeps every process in the lane group the
//   gate owns). A runner still running a bounded time after that stops its
//   group and exits, so a hang in its own awaited work cannot outlive it.
// - A lane token. The runner starts a token carrier: an idle same-group
//   process whose command line ends with the token, from the runner's start
//   until its group is stopped. A later gate run uses it to recognise an
//   orphaned lane group after the gate and the runner were both killed, in
//   whatever step the lane was, without trusting a numeric id alone.
// - The deadline itself, for the runner's messages.
//
// When all of its work is done, the runner stops its own process group: TERM,
// which it ignores itself, then, after a bounded wait, KILL to each member
// still running. So a same-group descendant, even one that ignores TERM, does
// not outlive the lane when the gate is no longer there to tear the group
// down.

export const LANE_DEADLINE_ENV = "DYFJ_LANE_DEADLINE_MS";
export const LANE_BACKSTOP_ENV = "DYFJ_LANE_BACKSTOP_MS";
export const LANE_TOKEN_ENV = "DYFJ_LANE_TOKEN";
export const LANE_ENV_NAMES = [
  LANE_DEADLINE_ENV,
  LANE_BACKSTOP_ENV,
  LANE_TOKEN_ENV,
] as const;

// How long a runner past its backstop may keep running before it stops its
// group and exits regardless.
export const BACKSTOP_EXIT_GRACE_MS = 30_000;
// How long the group stop waits after TERM before it KILLs what is left.
export const GROUP_STOP_GRACE_MS = 2_000;

// The longest delay a Deno timer honours. A longer one fires after about 1 ms
// instead, so a supervision value past it is malformed.
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

const LANE_TOKEN_ARG_PREFIX = "--dyfj-lane=";
const LANE_TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface LaneSupervision {
  deadlineMs: number;
  backstopMs: number;
  token: string;
}

// A run outside the gate may not be granted these names at all; an ungranted
// read counts as unset.
function readGrantedEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

function pathEnvironment(): Record<string, string> {
  const path = readGrantedEnv("PATH");
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
 * start. All three values must be present and well formed.
 */
export function laneSupervision(
  read: (name: string) => string | undefined = readGrantedEnv,
): LaneSupervision | undefined {
  const deadlineMs = positiveInteger(read(LANE_DEADLINE_ENV));
  const backstopMs = positiveInteger(read(LANE_BACKSTOP_ENV));
  const token = read(LANE_TOKEN_ENV);
  if (
    deadlineMs === undefined || backstopMs === undefined ||
    token === undefined || !isLaneToken(token)
  ) {
    return undefined;
  }
  return { deadlineMs, backstopMs, token };
}

// The carrier's program, with the lane group's id (the runner's pid) and the
// lane token argument as script arguments; the token trails the command line,
// and the program's first line says what the process is to anyone reading a
// process list. On TERM it does not exit at once: it waits until nothing but
// itself and the group's leader is left in the group, then exits. So a
// teardown whose TERM ends the lane's processes is not held up by the carrier,
// while a descendant that ignores TERM keeps it, and with it the token, in the
// group until the teardown's KILL: a supervisor killed between TERM and KILL
// still leaves the group recoverable.
const TOKEN_CARRIER_PROGRAM =
  `// dyfj test-lane token carrier: holds its lane's token until the lane's group is empty
const group = Number(Deno.args[0]);
let leaving = false;
async function othersLeft() {
  try {
    const out = await new Deno.Command("ps", {
      args: ["-A", "-o", "pid=,ppid=,pgid=,stat="],
      stdout: "piped", stderr: "null",
    }).output();
    if (!out.success) return true;
    // Neither this process, its own \`ps\`, nor the group's leader counts.
    return new TextDecoder().decode(out.stdout).split("\\n").some((line) => {
      const [pid, ppid, pgid, stat] = line.trim().split(/\\s+/);
      return Number(pgid) === group && Number(pid) !== Deno.pid &&
        Number(ppid) !== Deno.pid && Number(pid) !== group &&
        stat !== undefined && !stat.startsWith("Z");
    });
  } catch {
    return true;
  }
}
Deno.addSignalListener("SIGTERM", async () => {
  if (leaving) return;
  leaving = true;
  while (await othersLeft()) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  Deno.exit(0);
});
setInterval(() => {}, 2 ** 30);
`;

/**
 * Starts the lane's token carrier in this process's group, for a gate lane
 * only and only outside Windows, where neither the group stop nor recovery
 * runs to end it. It runs until the group is stopped and does not keep this
 * process alive. `deno` is the selected Deno executable the runner may
 * already run.
 */
export function startTokenCarrier(
  supervision: LaneSupervision | undefined,
  deno: string,
): void {
  if (supervision === undefined || Deno.build.os === "windows") return;
  const carrier = new Deno.Command(deno, {
    args: [
      "eval",
      "--allow-run",
      TOKEN_CARRIER_PROGRAM,
      "--",
      String(Deno.pid),
      laneTokenArgument(supervision.token),
    ],
    clearEnv: true,
    // PATH, to find `ps`, when this runner may read it.
    env: pathEnvironment(),
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();
  carrier.unref();
}

export interface Backstop {
  /** Whether the backstop fired. */
  readonly expired: boolean;
  clear(): void;
}

/**
 * Calls `onExpire` once the backstop passes, unless cleared first. Once it has
 * passed, clearing no longer helps: if this process is still running
 * `exitGraceMs` later, it stops its own group and exits 1, whatever it was
 * waiting on. `deno` is the selected Deno executable, for the group stop.
 */
export function startBackstop(
  supervision: LaneSupervision | undefined,
  deno: string,
  onExpire: () => void,
  exitGraceMs = BACKSTOP_EXIT_GRACE_MS,
): Backstop {
  let expired = false;
  const timer = supervision === undefined ? undefined : setTimeout(() => {
    expired = true;
    const exit = setTimeout(async () => {
      console.error(
        `dyfj: the lane was still running ${exitGraceMs} ms past its backstop deadline (${supervision.backstopMs} ms); stopping it`,
      );
      await stopOwnGroup(supervision, deno);
      Deno.exit(1);
    }, exitGraceMs);
    // The exit timer never keeps the runner alive on its own.
    Deno.unrefTimer(exit);
    onExpire();
  }, supervision.backstopMs);
  return {
    get expired() {
      return expired;
    },
    clear() {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

/** Kills a child by pid, ignoring one that already exited. */
export function killChild(child: Deno.ChildProcess): void {
  try {
    child.kill("SIGKILL");
  } catch {
    // Already exited.
  }
}

// Run by a short-lived same-group child, with the runner's pid, the grace in
// ms and the lane token argument as script arguments: TERM to the group (which
// the child and the runner ignore, and which leaves the token carrier waiting
// for this child), then, once only the carrier is left or the grace has
// passed, KILL to each member still running, the carrier included, by pid, so
// neither the runner nor the child is killed. A zombie counts as gone. While the runner is alive it leads the
// group, so the group id cannot name another group.
const GROUP_STOP_PROGRAM = `
Deno.addSignalListener("SIGTERM", () => {});
const [runner, grace, tokenArgument] = Deno.args;
const group = Number(runner);
const spared = new Set([group, Deno.pid]);
try { Deno.kill(-group, "SIGTERM"); } catch { Deno.exit(0); }
async function members() {
  try {
    const out = await new Deno.Command("ps", {
      args: ["-A", "-ww", "-o", "pid=,ppid=,pgid=,stat=,command="],
      stdout: "piped", stderr: "null",
    }).output();
    const rows = new TextDecoder().decode(out.stdout).split("\\n").flatMap((line) => {
      const match = line.match(/^\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\S+)\\s+(.*)$/);
      if (!match) return [];
      const [, pid, ppid, pgid, stat, command] = match;
      return Number(pgid) === group && !spared.has(Number(pid)) &&
          !stat.startsWith("Z")
        ? [{
          pid: Number(pid),
          ppid: Number(ppid),
          carrier: command.endsWith(tokenArgument),
        }]
        : [];
    });
    // This child's own \`ps\` is not a member to wait for, and a carrier's own
    // \`ps\` counts as part of the carrier.
    const carriers = new Set(rows.filter((r) => r.carrier).map((r) => r.pid));
    return rows.flatMap((r) =>
      r.ppid === Deno.pid
        ? []
        : [{ pid: r.pid, carrier: r.carrier || carriers.has(r.ppid) }]
    );
  } catch {
    return [];
  }
}
const deadline = Date.now() + Number(grace);
let left = await members();
while (left.some((m) => !m.carrier) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 50));
  left = await members();
}
for (const { pid } of left) {
  try { Deno.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}
Deno.exit(0);
`;

/**
 * Stops this process's own group once the lane's work is done: TERM, which
 * this process ignores, then KILL to whatever is left after
 * `GROUP_STOP_GRACE_MS`. Only a gate lane does this, and only outside
 * Windows. `deno` is the selected Deno executable the runner may already run:
 * signalling a group needs unscoped run permission, so a short-lived child
 * carries the signals. If this process does not lead a group, the signal
 * names no group and reaches nothing.
 */
export async function stopOwnGroup(
  supervision: LaneSupervision | undefined,
  deno: string,
): Promise<void> {
  if (supervision === undefined || Deno.build.os === "windows") return;
  // Stays installed: the runner exits right after this.
  Deno.addSignalListener("SIGTERM", () => {});
  try {
    await new Deno.Command(deno, {
      args: [
        "eval",
        "--allow-run",
        GROUP_STOP_PROGRAM,
        "--",
        String(Deno.pid),
        String(GROUP_STOP_GRACE_MS),
        laneTokenArgument(supervision.token),
      ],
      clearEnv: true,
      // PATH, to find `ps`, when this runner may read it.
      env: pathEnvironment(),
      stdout: "null",
      stderr: "null",
    }).output();
  } catch {
    // Best effort: the gate's own teardown remains when it is alive.
  }
}
