/**
 * The subset check: a session policy must sit inside the run envelope it was
 * granted from, group by group. A session may narrow anything and widen
 * nothing.
 *
 * Every violation is reported, never just the first. A violation names a field
 * path and a kind, never a value, so a list can be logged or shown without
 * leaking a host's URL path, a secret name's value or anything else the policy
 * holds. Matching is exact: no wildcard, suffix or prefix match on a host, and
 * filesystem containment is segment-wise on canonical absolute paths, so
 * `/workspace` is not inside `/work`. No file, clock, environment or
 * randomness is read here.
 */

import type {
  EffectivePolicy,
  FilesystemRoot,
  NetworkEntry,
} from "./effective-policy.ts";
import type { PermissionLevel } from "./schema.ts";

export interface PolicyViolation {
  /** Where the session breaks its envelope, as `group.field[index]`. */
  readonly path: string;
  /** What is wrong, as a fixed token. */
  readonly kind: string;
}

/** A session policy outside its run envelope. Carries every violation. */
export class PolicyEnvelopeError extends Error {
  readonly violations: readonly PolicyViolation[];

  constructor(violations: readonly PolicyViolation[]) {
    super(
      `session policy is outside its run envelope: ${
        violations.map((v) => `${v.path} (${v.kind})`).join(", ")
      }`,
    );
    this.name = "PolicyEnvelopeError";
    this.violations = Object.freeze(violations.map((v) => Object.freeze(v)));
  }
}

/** Looser postures rank higher. */
const POSTURE_RANK: Readonly<Record<PermissionLevel, number>> = {
  strict: 0,
  operator: 1,
};

type Report = (path: string, kind: string) => void;

function checkIdentity(
  session: EffectivePolicy,
  run: EffectivePolicy,
  report: Report,
) {
  if (session.version !== run.version) report("version", "version-mismatch");
  for (const field of ["principal", "job", "run"] as const) {
    if (session.identity[field] !== run.identity[field]) {
      report(`identity.${field}`, "identity-mismatch");
    }
  }
  session.identity.repositories.forEach((repository, index) => {
    if (!run.identity.repositories.includes(repository)) {
      report(`identity.repositories[${index}]`, "not-in-run");
    }
  });
  const sessionExpiry = Date.parse(session.identity.expiresAt);
  const runExpiry = Date.parse(run.identity.expiresAt);
  if (Number.isNaN(sessionExpiry) || Number.isNaN(runExpiry)) {
    report("identity.expiresAt", "invalid-instant");
  } else if (sessionExpiry > runExpiry) {
    report("identity.expiresAt", "expires-after-run");
  }
}

/**
 * The segments of a canonical absolute path, or null when `path` is relative
 * or has an empty, `.` or `..` segment.
 */
function canonicalSegments(path: string): string[] | null {
  if (!path.startsWith("/")) return null;
  if (path === "/") return [];
  const segments = path.slice(1).split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return null;
  }
  return segments;
}

function within(inner: readonly string[], outer: readonly string[]): boolean {
  return outer.length <= inner.length &&
    outer.every((segment, index) => inner[index] === segment);
}

function checkRoot(
  root: FilesystemRoot,
  path: string,
  runRoots: readonly FilesystemRoot[],
  report: Report,
) {
  const segments = canonicalSegments(root.source);
  if (segments === null) {
    report(`${path}.source`, "not-canonical");
    return;
  }
  const containing = runRoots.filter((runRoot) => {
    const outer = canonicalSegments(runRoot.source);
    return outer !== null && within(segments, outer);
  });
  if (containing.length === 0) {
    report(`${path}.source`, "outside-run-roots");
    return;
  }
  const sameTarget = containing.filter((runRoot) =>
    runRoot.target === root.target
  );
  if (sameTarget.length === 0) {
    report(`${path}.target`, "target-mismatch");
    return;
  }
  const granted = sameTarget.some((runRoot) =>
    root.rights.every((right) => runRoot.rights.includes(right))
  );
  if (!granted) report(`${path}.rights`, "right-not-granted");
}

function checkFilesystem(
  session: EffectivePolicy,
  run: EffectivePolicy,
  report: Report,
) {
  session.filesystem.roots.forEach((root, index) =>
    checkRoot(root, `filesystem.roots[${index}]`, run.filesystem.roots, report)
  );
  if (
    session.filesystem.scratch !== null &&
    session.filesystem.scratch !== run.filesystem.scratch
  ) {
    report("filesystem.scratch", "not-in-run");
  }
  for (const field of ["forbiddenPaths", "protectedGit"] as const) {
    if (
      !run.filesystem[field].every((path) =>
        session.filesystem[field].includes(path)
      )
    ) {
      report(`filesystem.${field}`, "drops-run-entry");
    }
  }
}

function sameEntry(a: NetworkEntry, b: NetworkEntry): boolean {
  return a.role === b.role && a.host === b.host && a.port === b.port &&
    a.protocol === b.protocol && a.dns === b.dns &&
    a.hostnameAssurance === b.hostnameAssurance;
}

function checkNetwork(
  session: EffectivePolicy,
  run: EffectivePolicy,
  report: Report,
) {
  session.network.entries.forEach((entry, index) => {
    if (!run.network.entries.some((runEntry) => sameEntry(entry, runEntry))) {
      report(`network.entries[${index}]`, "not-in-run");
    }
  });
  session.network.brokerOperations.forEach((operation, index) => {
    if (!run.network.brokerOperations.includes(operation)) {
      report(`network.brokerOperations[${index}]`, "not-in-run");
    }
  });
  if (
    session.network.dolt !== null && session.network.dolt !== run.network.dolt
  ) {
    report("network.dolt", "not-in-run");
  }
}

/** `session` is at most `run`; null is unbounded. */
function withinLimit(session: number | null, run: number | null): boolean {
  if (run === null) return true;
  return session !== null && session <= run;
}

function checkProcesses(
  session: EffectivePolicy,
  run: EffectivePolicy,
  report: Report,
) {
  const processes = session.processes;
  processes.executables.forEach((executable, index) => {
    const granted = run.processes.executables.some((runExecutable) =>
      runExecutable.program === executable.program &&
      runExecutable.role === executable.role &&
      (runExecutable.digest === null ||
        runExecutable.digest === executable.digest)
    );
    if (!granted) report(`processes.executables[${index}]`, "not-in-run");
  });
  if (processes.descendants && !run.processes.descendants) {
    report("processes.descendants", "not-in-run");
  }
  if (!withinLimit(processes.maxProcesses, run.processes.maxProcesses)) {
    report("processes.maxProcesses", "above-run-limit");
  }
  if (
    run.processes.syscallProfile !== null &&
    processes.syscallProfile !== run.processes.syscallProfile
  ) {
    report("processes.syscallProfile", "profile-mismatch");
  }
  processes.environment.forEach((name, index) => {
    if (!run.processes.environment.includes(name)) {
      report(`processes.environment[${index}]`, "not-in-run");
    }
  });
}

function checkCredentialRefs(
  session: EffectivePolicy,
  run: EffectivePolicy,
  report: Report,
) {
  session.secrets.forEach((ref, index) => {
    const granted = run.secrets.some((runRef) =>
      runRef.name === ref.name && runRef.owner === ref.owner
    );
    if (!granted) report(`secrets[${index}]`, "not-in-run");
  });
}

function checkEffects(
  session: EffectivePolicy,
  run: EffectivePolicy,
  report: Report,
) {
  const effects = session.effects;
  for (const field of ["tools", "externalMutations"] as const) {
    effects[field].forEach((name, index) => {
      if (!run.effects[field].includes(name)) {
        report(`effects.${field}[${index}]`, "not-in-run");
      }
    });
  }
  if (
    POSTURE_RANK[effects.approvalPosture] >
      POSTURE_RANK[run.effects.approvalPosture]
  ) {
    report("effects.approvalPosture", "looser-than-run");
  }
  if (effects.paidRouting && !run.effects.paidRouting) {
    report("effects.paidRouting", "not-in-run");
  }
  const limits = effects.limits;
  const runLimits = run.effects.limits;
  for (const field of ["timeMs", "steps", "outputBytes"] as const) {
    if (!withinLimit(limits[field], runLimits[field])) {
      report(`effects.limits.${field}`, "above-run-limit");
    }
  }
  for (const field of ["session", "perCall", "daily"] as const) {
    if (
      !withinLimit(
        limits.spendMicroUsd[field],
        runLimits.spendMicroUsd[field],
      )
    ) {
      report(`effects.limits.spendMicroUsd.${field}`, "above-run-limit");
    }
  }
}

/**
 * Every way `session` breaks out of `run`, in group order. Empty when the
 * session is within its envelope. The digests are not compared: any narrower
 * session has a different one.
 */
export function checkSessionWithinRun(
  session: EffectivePolicy,
  run: EffectivePolicy,
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  const report: Report = (path, kind) => violations.push({ path, kind });
  checkIdentity(session, run, report);
  checkFilesystem(session, run, report);
  checkNetwork(session, run, report);
  checkProcesses(session, run, report);
  checkCredentialRefs(session, run, report);
  checkEffects(session, run, report);
  return violations;
}

/** Throw a `PolicyEnvelopeError` unless `session` is within `run`. */
export function assertSessionWithinRun(
  session: EffectivePolicy,
  run: EffectivePolicy,
): void {
  const violations = checkSessionWithinRun(session, run);
  if (violations.length > 0) throw new PolicyEnvelopeError(violations);
}
