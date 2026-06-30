import { dirname, join, normalize, relative, resolve } from "node:path";

export type CoordinationClaimStatus =
  | "active"
  | "completed"
  | "blocked"
  | "parked"
  | "abandoned"
  | "handoff";

export interface AgentProfile {
  agentId: string;
  harness?: string;
  model?: string;
}

export interface CoordinationClaim {
  id: string;
  workItemRef: string;
  agent: AgentProfile;
  repo: string;
  workspace: string;
  branch: string;
  targetBranch: string;
  baseSnapshot: string;
  declaredIntent: string;
  scopePaths: string[];
  status: CoordinationClaimStatus;
  createdAt: string;
  updatedAt: string;
  lastHeartbeatAt?: string;
  expiresAt?: string;
  launchPacketPath: string;
  exitReceiptPath?: string;
  exitSummary?: string;
}

export interface CoordinationRegistry {
  version: 1;
  coordinationClaims: CoordinationClaim[];
}

export interface CoordinationStorePaths {
  registryPath: string;
  launchPacketDir: string;
  receiptDir: string;
}

export interface CoordinationRuntime {
  env: { get(key: string): string | undefined };
  now?: () => Date;
  uuid?: () => string;
  command?: (
    cmd: string,
    args: string[],
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface StartCoordinationClaimInput {
  workItemRef: string;
  repo: string;
  intent: string;
  scopePaths: string[];
  agentId?: string;
  harness?: string;
  model?: string;
  targetBranch?: string;
  expiresAt?: string;
}

export interface CoordinationWarning {
  code:
    | "path-overlap"
    | "stale-base"
    | "missing-workspace"
    | "missing-heartbeat"
    | "branch-drift"
    | "expired"
    | "unregistered-workspace";
  message: string;
  claimIds: string[];
}

export interface CoordinationRadarEntry {
  claim: CoordinationClaim;
  targetSnapshot?: string;
  warnings: CoordinationWarning[];
}

export interface CoordinationRadar {
  entries: CoordinationRadarEntry[];
  warnings: CoordinationWarning[];
}

const REGISTRY_VERSION = 1;
const ACTIVE_STATUSES = new Set<CoordinationClaimStatus>(["active"]);
const DEFAULT_HEARTBEAT_MAX_AGE_MINUTES = 120;

export function resolveCoordinationStorePaths(
  env: { get(key: string): string | undefined },
): CoordinationStorePaths {
  const explicit = env.get("DYFJ_COORDINATION_REGISTRY");
  const home = env.get("HOME") ?? ".";
  const baseDir = env.get("DYFJ_COORDINATION_HOME") ??
    join(home, ".dyfj", "coordination");
  return {
    registryPath: explicit ?? join(baseDir, "coordination-claims.json"),
    launchPacketDir: join(baseDir, "launch-packets"),
    receiptDir: join(baseDir, "receipts"),
  };
}

export function emptyRegistry(): CoordinationRegistry {
  return { version: REGISTRY_VERSION, coordinationClaims: [] };
}

export async function readRegistry(
  path: string,
): Promise<CoordinationRegistry> {
  try {
    const raw = await Deno.readTextFile(path);
    const parsed = JSON.parse(raw) as Partial<CoordinationRegistry>;
    if (
      parsed.version !== REGISTRY_VERSION ||
      !Array.isArray(parsed.coordinationClaims)
    ) {
      throw new Error(`unsupported coordination registry format at ${path}`);
    }
    return {
      version: REGISTRY_VERSION,
      coordinationClaims: parsed.coordinationClaims,
    };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return emptyRegistry();
    throw error;
  }
}

async function withRegistryLock<T>(
  path: string,
  fn: (
    registry: CoordinationRegistry,
  ) => Promise<{ registry: CoordinationRegistry; value: T }>,
): Promise<T> {
  await Deno.mkdir(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  let lock: Deno.FsFile | undefined;
  for (let i = 0; i < 50; i++) {
    try {
      lock = await Deno.open(lockPath, { createNew: true, write: true });
      break;
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  if (lock === undefined) {
    throw new Error(`coordination registry is locked: ${lockPath}`);
  }
  try {
    const current = await readRegistry(path);
    const { registry, value } = await fn(current);
    const tmp = `${path}.${crypto.randomUUID()}.tmp`;
    await Deno.writeTextFile(tmp, `${JSON.stringify(registry, null, 2)}\n`);
    await Deno.rename(tmp, path);
    return value;
  } finally {
    lock.close();
    await Deno.remove(lockPath).catch(() => {});
  }
}

async function defaultCommand(
  cmd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const output = await new Deno.Command(cmd, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  return {
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  };
}

async function git(
  runtime: CoordinationRuntime,
  repo: string,
  args: string[],
): Promise<string> {
  const command = runtime.command ?? defaultCommand;
  const result = await command("git", ["-C", repo, ...args]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

async function repoRoot(
  runtime: CoordinationRuntime,
  repo: string,
): Promise<string> {
  return await git(runtime, repo, ["rev-parse", "--show-toplevel"]);
}

async function currentBranch(
  runtime: CoordinationRuntime,
  repo: string,
): Promise<string> {
  const branch = await git(runtime, repo, ["branch", "--show-current"]);
  return branch || "HEAD";
}

async function revParse(
  runtime: CoordinationRuntime,
  repo: string,
  ref: string,
): Promise<string> {
  return await git(runtime, repo, ["rev-parse", ref]);
}

function nowIso(runtime: CoordinationRuntime): string {
  return (runtime.now?.() ?? new Date()).toISOString();
}

function heartbeatMaxAgeMinutes(runtime: CoordinationRuntime): number {
  const raw = runtime.env.get("DYFJ_COORDINATION_HEARTBEAT_MAX_AGE_MINUTES");
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_HEARTBEAT_MAX_AGE_MINUTES;
}

function newCoordinationClaimId(runtime: CoordinationRuntime): string {
  return `claim_${
    (runtime.uuid?.() ?? crypto.randomUUID()).replace(/-/g, "").slice(0, 20)
  }`;
}

function normalizeScopePaths(scopePaths: string[]): string[] {
  return [
    ...new Set(scopePaths.map((p) => normalize(p.trim())).filter(Boolean)),
  ]
    .sort();
}

function normalizeRepoPath(path: string): string {
  return resolve(path);
}

export function pathsOverlap(a: string, b: string): boolean {
  const left = normalize(a);
  const right = normalize(b);
  if (left === right || left === "." || right === ".") return true;
  const ltr = relative(left, right);
  const rtl = relative(right, left);
  return (!ltr.startsWith("..") && ltr !== "") ||
    (!rtl.startsWith("..") && rtl !== "");
}

function claimScopesOverlap(
  a: CoordinationClaim,
  b: CoordinationClaim,
): boolean {
  return a.scopePaths.some((left) =>
    b.scopePaths.some((right) => pathsOverlap(left, right))
  );
}

async function writeLaunchPacket(
  paths: CoordinationStorePaths,
  claim: CoordinationClaim,
): Promise<string> {
  await Deno.mkdir(paths.launchPacketDir, { recursive: true });
  const path = join(paths.launchPacketDir, `${claim.id}.md`);
  const body = `# DYFJ Session Coordination Launch Packet

Coordination claim: ${claim.id}
Work item: ${claim.workItemRef}
Agent: ${claim.agent.agentId}
Harness: ${claim.agent.harness ?? "(unspecified)"}
Model: ${claim.agent.model ?? "(unspecified)"}

## Workspace

- Repo: ${claim.repo}
- Workspace: ${claim.workspace}
- Branch: ${claim.branch}
- Target branch: ${claim.targetBranch}
- Base snapshot: ${claim.baseSnapshot}

## Intent

${claim.declaredIntent}

## Scope Paths

${claim.scopePaths.map((p) => `- ${p}`).join("\n")}

## Instructions

- Stay within the declared scope unless the operator approves expansion.
- Treat other active coordination claims as potentially overlapping work.
- Before committing or handing off, run the relevant checks and record evidence.
- On exit, leave a concise summary, validation evidence, and next action.
`;
  await Deno.writeTextFile(path, body);
  return path;
}

export async function startCoordinationClaim(
  input: StartCoordinationClaimInput,
  runtime: CoordinationRuntime,
): Promise<CoordinationClaim> {
  const paths = resolveCoordinationStorePaths(runtime.env);
  const root = normalizeRepoPath(await repoRoot(runtime, input.repo));
  const workspace = normalizeRepoPath(input.repo);
  const branch = await currentBranch(runtime, workspace);
  const targetBranch = input.targetBranch ?? branch;
  const baseSnapshot = await revParse(runtime, workspace, "HEAD");
  const createdAt = nowIso(runtime);
  const claim: CoordinationClaim = {
    id: newCoordinationClaimId(runtime),
    workItemRef: input.workItemRef,
    agent: {
      agentId: input.agentId ?? "operator",
      harness: input.harness,
      model: input.model,
    },
    repo: root,
    workspace,
    branch,
    targetBranch,
    baseSnapshot,
    declaredIntent: input.intent,
    scopePaths: normalizeScopePaths(input.scopePaths),
    status: "active",
    createdAt,
    updatedAt: createdAt,
    lastHeartbeatAt: createdAt,
    expiresAt: input.expiresAt,
    launchPacketPath: "",
  };
  claim.launchPacketPath = await writeLaunchPacket(paths, claim);
  return await withRegistryLock(paths.registryPath, async (registry) => {
    registry.coordinationClaims.push(claim);
    return { registry, value: claim };
  });
}

export async function heartbeatCoordinationClaim(
  id: string,
  runtime: CoordinationRuntime,
): Promise<CoordinationClaim> {
  const paths = resolveCoordinationStorePaths(runtime.env);
  return await withRegistryLock(paths.registryPath, async (registry) => {
    const claim = registry.coordinationClaims.find((r) => r.id === id);
    if (claim === undefined) {
      throw new Error(`unknown coordination claim: ${id}`);
    }
    const timestamp = nowIso(runtime);
    claim.lastHeartbeatAt = timestamp;
    claim.updatedAt = timestamp;
    return { registry, value: claim };
  });
}

export async function exitCoordinationClaim(
  id: string,
  status: Exclude<CoordinationClaimStatus, "active">,
  summary: string,
  runtime: CoordinationRuntime,
): Promise<CoordinationClaim> {
  const paths = resolveCoordinationStorePaths(runtime.env);
  await Deno.mkdir(paths.receiptDir, { recursive: true });
  return await withRegistryLock(paths.registryPath, async (registry) => {
    const claim = registry.coordinationClaims.find((r) => r.id === id);
    if (claim === undefined) {
      throw new Error(`unknown coordination claim: ${id}`);
    }
    claim.status = status;
    claim.updatedAt = nowIso(runtime);
    claim.exitSummary = summary;
    claim.exitReceiptPath = join(paths.receiptDir, `${claim.id}.md`);
    await Deno.writeTextFile(
      claim.exitReceiptPath,
      `# DYFJ Session Coordination Exit Receipt

Coordination claim: ${claim.id}
Work item: ${claim.workItemRef}
Status: ${status}
Updated: ${claim.updatedAt}

## Summary

${summary}
`,
    );
    return { registry, value: claim };
  });
}

export async function loadCoordinationClaims(
  runtime: CoordinationRuntime,
): Promise<CoordinationClaim[]> {
  const paths = resolveCoordinationStorePaths(runtime.env);
  return (await readRegistry(paths.registryPath)).coordinationClaims;
}

async function workspaceExists(claim: CoordinationClaim): Promise<boolean> {
  try {
    const stat = await Deno.stat(claim.workspace);
    return stat.isDirectory;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

export async function buildRadar(
  runtime: CoordinationRuntime,
): Promise<CoordinationRadar> {
  const claims = (await loadCoordinationClaims(runtime)).filter((claim) =>
    ACTIVE_STATUSES.has(claim.status)
  );
  const entries: CoordinationRadarEntry[] = [];
  const warnings: CoordinationWarning[] = [];
  const now = runtime.now?.() ?? new Date();

  for (const claim of claims) {
    const claimWarnings: CoordinationWarning[] = [];
    if (!(await workspaceExists(claim))) {
      claimWarnings.push({
        code: "missing-workspace",
        message: `workspace missing: ${claim.workspace}`,
        claimIds: [claim.id],
      });
    }
    if (claim.expiresAt !== undefined && new Date(claim.expiresAt) < now) {
      claimWarnings.push({
        code: "expired",
        message: `coordination claim expired at ${claim.expiresAt}`,
        claimIds: [claim.id],
      });
    }
    const heartbeatAt = claim.lastHeartbeatAt === undefined
      ? undefined
      : new Date(claim.lastHeartbeatAt);
    const maxAgeMs = heartbeatMaxAgeMinutes(runtime) * 60 * 1000;
    if (
      heartbeatAt === undefined ||
      !Number.isFinite(heartbeatAt.getTime()) ||
      now.getTime() - heartbeatAt.getTime() > maxAgeMs
    ) {
      claimWarnings.push({
        code: "missing-heartbeat",
        message: `coordination heartbeat stale or missing: ${
          claim.lastHeartbeatAt ?? "(never)"
        }`,
        claimIds: [claim.id],
      });
    }
    let targetSnapshot: string | undefined;
    try {
      targetSnapshot = await revParse(runtime, claim.repo, claim.targetBranch);
      if (targetSnapshot !== claim.baseSnapshot) {
        claimWarnings.push({
          code: "stale-base",
          message: `${claim.targetBranch} advanced beyond ${
            claim.baseSnapshot.slice(0, 12)
          }`,
          claimIds: [claim.id],
        });
      }
    } catch {
      // Missing target branches are surfaced by git during integration; keep radar readable.
    }
    entries.push({ claim, targetSnapshot, warnings: claimWarnings });
    warnings.push(...claimWarnings);
  }

  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      const a = claims[i];
      const b = claims[j];
      if (a.repo === b.repo && claimScopesOverlap(a, b)) {
        const warning: CoordinationWarning = {
          code: "path-overlap",
          message: `${a.id} and ${b.id} declare overlapping scope paths`,
          claimIds: [a.id, b.id],
        };
        warnings.push(warning);
        entries.find((entry) => entry.claim.id === a.id)?.warnings.push(
          warning,
        );
        entries.find((entry) => entry.claim.id === b.id)?.warnings.push(
          warning,
        );
      }
    }
  }

  return { entries, warnings };
}

export interface ReconcileResult {
  warnings: CoordinationWarning[];
}

export async function reconcileCoordinationClaims(
  runtime: CoordinationRuntime,
): Promise<ReconcileResult> {
  const warnings: CoordinationWarning[] = [];
  for (const claim of await loadCoordinationClaims(runtime)) {
    if (ACTIVE_STATUSES.has(claim.status) && !(await workspaceExists(claim))) {
      warnings.push({
        code: "missing-workspace",
        message: `workspace missing: ${claim.workspace}`,
        claimIds: [claim.id],
      });
      continue;
    }
    if (ACTIVE_STATUSES.has(claim.status)) {
      try {
        const branch = await currentBranch(runtime, claim.workspace);
        if (branch !== claim.branch) {
          warnings.push({
            code: "branch-drift",
            message:
              `${claim.id} recorded branch ${claim.branch}, workspace is on ${branch}`,
            claimIds: [claim.id],
          });
        }
      } catch {
        // Non-git or unreadable workspaces remain advisory; hook checks surface git failures.
      }
    }
  }
  return { warnings };
}

export async function hookCheck(
  repo: string,
  runtime: CoordinationRuntime,
): Promise<CoordinationWarning[]> {
  const root = normalizeRepoPath(await repoRoot(runtime, repo));
  const workspace = normalizeRepoPath(repo);
  const branch = await currentBranch(runtime, repo);
  const claims = (await loadCoordinationClaims(runtime)).filter((claim) =>
    ACTIVE_STATUSES.has(claim.status) && claim.repo === root
  );
  const matching = claims.filter((claim) =>
    claim.workspace === workspace || claim.branch === branch
  );
  const warnings: CoordinationWarning[] = [];
  if (!matching.some((claim) => claim.workspace === workspace)) {
    warnings.push({
      code: "unregistered-workspace",
      message: `no active coordination claim registered for ${workspace}`,
      claimIds: [],
    });
  }
  const radar = await buildRadar(runtime);
  for (const warning of radar.warnings) {
    if (
      warning.claimIds.some((id) => matching.some((claim) => claim.id === id))
    ) {
      warnings.push(warning);
    }
  }
  return warnings;
}

export function formatCoordinationClaimList(
  claims: CoordinationClaim[],
): string {
  if (claims.length === 0) return "no coordination claims\n";
  return claims.map((claim) =>
    `${claim.id}  ${
      claim.status.padEnd(9)
    }  ${claim.workItemRef}  ${claim.branch}  ${claim.declaredIntent}`
  ).join("\n") + "\n";
}

export function formatRadar(radar: CoordinationRadar): string {
  if (radar.entries.length === 0) return "no active coordination claims\n";
  const lines: string[] = [];
  for (const entry of radar.entries) {
    const { claim } = entry;
    lines.push(`${claim.id}  ${claim.workItemRef}  ${claim.agent.agentId}`);
    lines.push(`  repo: ${claim.repo}`);
    lines.push(`  worktree: ${claim.workspace}`);
    lines.push(`  branch: ${claim.branch} -> ${claim.targetBranch}`);
    lines.push(`  base: ${claim.baseSnapshot.slice(0, 12)}`);
    lines.push(`  last heartbeat: ${claim.lastHeartbeatAt ?? "(never)"}`);
    lines.push(`  intent: ${claim.declaredIntent}`);
    lines.push(`  scope: ${claim.scopePaths.join(", ") || "(none)"}`);
    for (const warning of entry.warnings) {
      lines.push(`  warning[${warning.code}]: ${warning.message}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
