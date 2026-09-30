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
//   the runner kills the child it is waiting on by pid, which keeps every
//   process in the lane group the gate owns.
// - A lane token. The runner passes it to `deno test` as a trailing script
//   argument, so the child's command line identifies its lane. A later gate
//   run uses it to recognise an orphaned lane group after the gate and the
//   runner were both killed, without trusting a numeric id alone.
// - The deadline itself, for the runner's messages.
//
// When all of its work is done, the runner stops its own process group with
// TERM, which it ignores itself, so a same-group grandchild does not outlive
// the lane even when the gate is no longer there to tear the group down.

export const LANE_DEADLINE_ENV = "DYFJ_LANE_DEADLINE_MS";
export const LANE_BACKSTOP_ENV = "DYFJ_LANE_BACKSTOP_MS";
export const LANE_TOKEN_ENV = "DYFJ_LANE_TOKEN";
export const LANE_ENV_NAMES = [
  LANE_DEADLINE_ENV,
  LANE_BACKSTOP_ENV,
  LANE_TOKEN_ENV,
] as const;

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

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^[1-9][0-9]{0,9}$/.test(value)) return undefined;
  return Number(value);
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

/**
 * Script arguments for a `deno test` child: the caller's own arguments, plus
 * the lane token when the gate supervises this run. Returned with the leading
 * `--`, or empty when there is nothing to pass.
 */
export function laneScriptArgs(
  supervision: LaneSupervision | undefined,
  scriptArgs: readonly string[] = [],
): string[] {
  const args = [
    ...scriptArgs,
    ...(supervision ? [laneTokenArgument(supervision.token)] : []),
  ];
  return args.length > 0 ? ["--", ...args] : [];
}

export interface Backstop {
  /** Whether the backstop fired. */
  readonly expired: boolean;
  clear(): void;
}

/** Calls `onExpire` once the backstop passes, unless cleared first. */
export function startBackstop(
  supervision: LaneSupervision | undefined,
  onExpire: () => void,
): Backstop {
  let expired = false;
  const timer = supervision === undefined ? undefined : setTimeout(() => {
    expired = true;
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

/**
 * Sends TERM to this process's own group once the lane's work is done, and
 * ignores that TERM itself. Only a gate lane does this, and only outside
 * Windows. `deno` is the selected Deno executable the runner may already run:
 * signalling a group needs unscoped run permission, so a short-lived child
 * carries the signal. If this process does not lead a group, the signal names
 * no group and reaches nothing.
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
        `try { Deno.kill(${-Deno.pid}, "SIGTERM"); } catch { /* no group */ }`,
      ],
      clearEnv: true,
      stdout: "null",
      stderr: "null",
    }).output();
  } catch {
    // Best effort: the gate's own teardown remains when it is alive.
  }
}
