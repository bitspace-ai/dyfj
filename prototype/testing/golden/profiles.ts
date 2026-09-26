/**
 * Engine server profiles the golden suite runs against. A profile is one
 * engine server process with its own boot-time configuration; the suite
 * starts each on first use. Kept apart from the suite so the lane runner can
 * derive the exact socket grants without loading any tests.
 */

export interface ServerProfile {
  /** Also the profile's directory name under the harness root. */
  name: string;
  /** Engine environment beyond the harness base (posture, multiples). */
  env: Record<string, string>;
  /** Wire the loopback Linear MCP fake and a friction checkpoint issue. */
  friction?: boolean;
}

export const OPERATOR: ServerProfile = {
  name: "operator",
  env: {
    DYFJ_PERMISSION_LEVEL: "operator",
    DYFJ_ANOMALY_TURN_MULTIPLE: "2",
  },
  friction: true,
};

export const STRICT: ServerProfile = {
  name: "strict",
  env: { DYFJ_PERMISSION_LEVEL: "strict" },
};

export const SERVER_PROFILES: readonly ServerProfile[] = [OPERATOR, STRICT];

/**
 * The profile's socket path. Deno grants Unix sockets by exact path only, so
 * the runner grants these ahead of time. Names stay short: a socket path is
 * capped near 104 bytes on macOS, where temp roots are already long.
 */
export function socketPathFor(root: string, profile: ServerProfile): string {
  return `${root}/${profile.name}/wb.sock`;
}
