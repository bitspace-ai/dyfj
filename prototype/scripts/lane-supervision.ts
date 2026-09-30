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

// The carrier's program. Its own text says what it is to anyone reading a
// process list; the token follows it as a script argument.
const TOKEN_CARRIER_PROGRAM =
  "// dyfj test-lane token carrier: idle until its lane's process group is stopped\n" +
  "setInterval(() => {}, 2 ** 30);";

/**
 * Starts the lane's token carrier in this process's group, for a gate lane
 * only. It runs until the group is stopped and does not keep this process
 * alive. `deno` is the selected Deno executable the runner may already run.
 */
export function startTokenCarrier(
  supervision: LaneSupervision | undefined,
  deno: string,
): void {
  if (supervision === undefined) return;
  const carrier = new Deno.Command(deno, {
    args: [
      "eval",
      TOKEN_CARRIER_PROGRAM,
      "--",
      laneTokenArgument(supervision.token),
    ],
    clearEnv: true,
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

// Run by a short-lived same-group child: TERM to the group (which the child
// and the runner ignore), then, once the other members are gone or the grace
// has passed, KILL to each member still running, by pid, so neither the
// runner nor the child is killed. A zombie counts as gone. While the runner
// is alive it leads the group, so the group id cannot name another group.
function groupStopProgram(runnerPid: number, graceMs: number): string {
  return `
Deno.addSignalListener("SIGTERM", () => {});
const group = ${runnerPid};
const spared = new Set([${runnerPid}, Deno.pid]);
try { Deno.kill(-group, "SIGTERM"); } catch { Deno.exit(0); }
async function members() {
  try {
    const out = await new Deno.Command("ps", {
      args: ["-A", "-o", "pid=,pgid=,stat="], stdout: "piped", stderr: "null",
    }).output();
    return new TextDecoder().decode(out.stdout).split("\\n").flatMap((line) => {
      const [pid, pgid, stat] = line.trim().split(/\\s+/);
      return Number(pgid) === group && !spared.has(Number(pid)) &&
          stat !== undefined && !stat.startsWith("Z")
        ? [Number(pid)]
        : [];
    });
  } catch {
    return [];
  }
}
const deadline = Date.now() + ${graceMs};
let left = await members();
while (left.length > 0 && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 50));
  left = await members();
}
for (const pid of left) {
  try { Deno.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}
Deno.exit(0);
`;
}

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
        groupStopProgram(Deno.pid, GROUP_STOP_GRACE_MS),
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
