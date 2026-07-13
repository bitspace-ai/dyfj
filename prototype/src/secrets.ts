/**
 * secrets.ts — resolve declared secret POINTERS into the process environment at
 * engine boot, so `dyfj start` alone yields a fully credentialed runtime.
 *
 * The config surface holds POINTERS, never values (see config.ts). At boot the
 * runtime invokes the operator-configured resolver command once per declared
 * pointer and sets the resulting value into `Deno.env`, exactly where the
 * providers already read it (`getEnv(NAME)` in provider.ts). The value lives
 * only in process env — the same posture the retired 1Password wrapper held —
 * never on the config object, in logs, or in an error message.
 *
 * Invariants:
 *   - env WINS: an already-set var is never overwritten (the resolver is a
 *     fallback for the operator projecting a key ambiently, e.g. `op run`).
 *   - BOUNDED, NON-TERMINAL: the command runs with stdin closed (no terminal
 *     prompt) and a timeout that SIGKILLs the immediate child, so a stalled or
 *     locked resolver degrades fail-closed instead of hanging the boot. Closing
 *     stdin does NOT stop a GUI-integrated manager (e.g. the 1Password app) from
 *     raising a biometric prompt out-of-band; the timeout still bounds the wait.
 *   - PRESENCE-ONLY: logging reports resolved / already-set / unavailable and a
 *     value-free reason; it never echoes the secret. Failure reasons surface the
 *     exit status, not captured command output (stderr may echo the pointer but
 *     must never carry the value into a log).
 */

import type { SecretsConfig } from "./config";

export type SecretStatus = "resolved" | "already-set" | "unavailable";

export interface SecretResolution {
  envVar: string;
  status: SecretStatus;
  /** Value-free reason, only for `unavailable`. */
  reason?: string;
}

/** Outcome of running the resolver command for one pointer. */
export interface SecretCommandResult {
  ok: boolean;
  /** The resolved secret value — present only when `ok`. */
  value?: string;
  /** A value-free failure reason (the timeout case names itself in the text). */
  reason?: string;
}

/** The env surface the resolver reads and writes; injectable for tests. */
export interface SecretsEnv {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

export type RunSecretCommand = (
  command: readonly string[],
  pointer: string,
  timeoutMs: number,
  /** The COMPLETE environment for the child (spawned with clearEnv). */
  env?: Readonly<Record<string, string>>,
) => Promise<SecretCommandResult>;

export interface ResolveSecretsDeps {
  env?: SecretsEnv;
  run?: RunSecretCommand;
  log?: (message: string) => void;
}

/**
 * The minimal ambient env forwarded into every resolver spawn. These are
 * non-secret operating variables the resolver needs to function (find its
 * binary, locate its config/session, reach the desktop-app socket) — NOT the
 * runtime's provider keys, database password, or memory token. All must be in
 * the runtime's `--allow-env` allowlist so reading them never throws NotCapable.
 * The operator adds anything else the resolver needs via `[secrets].inherit_env`.
 */
const RESOLVER_ENV_BASE: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "XDG_RUNTIME_DIR",
];

/** Read one ambient var, treating an ungranted read (NotCapable) as unset. */
function readAmbient(env: SecretsEnv, name: string): string | undefined {
  try {
    return env.get(name);
  } catch {
    return undefined;
  }
}

/**
 * Build the resolver's ISOLATED environment: the minimal base plus the
 * operator's `inheritEnv` forward-list (both read from the ambient env), with
 * `[secrets.env]` literals merged on top. The resolver spawns with `clearEnv`,
 * so it sees ONLY this — never the runtime's other secrets. Trusting a command
 * to resolve one pointer does not require handing it every credential the
 * runtime holds; a compromised or misconfigured resolver's blast radius is
 * bounded to what is forwarded here.
 */
export function buildResolverEnv(
  secrets: SecretsConfig,
  env: SecretsEnv,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of [...RESOLVER_ENV_BASE, ...secrets.inheritEnv]) {
    const value = readAmbient(env, name);
    if (value !== undefined) result[name] = value;
  }
  for (const [name, value] of Object.entries(secrets.env)) {
    result[name] = value;
  }
  return result;
}

/** Sentinel raced against the resolver's output to enforce the timeout. */
const TIMEOUT = Symbol("secret-resolver-timeout");

/**
 * Default resolver runner: spawn `command[0]` with the remaining argv plus the
 * pointer as the final argument. stdin is closed so a command that would prompt
 * cannot read a response, and the timeout is enforced by RACING the output
 * against a timer rather than merely killing the child and awaiting it: a
 * resolver that spawns a descendant holding the piped stdout/stderr fds could
 * keep `child.output()` pending past a SIGKILL of the parent, so on timeout we
 * kill, stop awaiting the output, and return — the boot is never held hostage
 * to a stuck resolver. Only a clean exit with non-empty stdout yields a value;
 * everything else is a value-free failure reason.
 */
export const runSecretCommand: RunSecretCommand = async (
  command,
  pointer,
  timeoutMs,
  env,
) => {
  const [bin, ...rest] = command;
  const args = [...rest, pointer];

  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(bin, {
      args,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      // ISOLATED environment: the resolver sees ONLY the explicit env passed
      // here (a minimal non-secret base + inherit_env + [secrets.env]), never
      // the runtime's other secrets. `clearEnv` is what enforces the least-
      // privilege boundary; the caller builds the env via buildResolverEnv.
      clearEnv: true,
      env: env ?? {},
    }).spawn();
  } catch {
    // NotCapable (no --allow-run for this binary) or the binary is missing.
    // Deliberately value-free and PATH-FREE: the raw exception text can contain
    // the configured (possibly absolute, operator-private) resolver path, which
    // must never reach a log or a returned reason.
    return {
      ok: false,
      reason: "cannot run the resolver command (not found or not permitted)",
    };
  }

  const outputPromise = child.output();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
  });

  let outcome: Deno.CommandOutput | typeof TIMEOUT;
  try {
    outcome = await Promise.race([outputPromise, timeoutPromise]);
  } catch {
    clearTimeout(timer);
    // Value-free and path-free (see the spawn catch above).
    return { ok: false, reason: "resolver command failed before returning" };
  }

  if (outcome === TIMEOUT) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited between the race settling and this firing.
    }
    // Do NOT await outputPromise — a pipe-holding descendant could keep it
    // pending. Swallow its eventual settlement so it can't surface as an
    // unhandled rejection.
    outputPromise.catch(() => {});
    return {
      ok: false,
      reason: `timed out after ${timeoutMs}ms (locked or unavailable)`,
    };
  }
  clearTimeout(timer);

  const output = outcome;
  if (!output.success) {
    // Surface the exit status only — never captured stdout/stderr, which could
    // carry the value.
    return { ok: false, reason: `resolver exited with code ${output.code}` };
  }

  const value = new TextDecoder().decode(output.stdout).trim();
  if (value.length === 0) {
    return { ok: false, reason: "resolver returned an empty value" };
  }
  return { ok: true, value };
};

/** A resolution before its value (if any) is written back to the environment. */
type StagedResolution =
  | { envVar: string; status: "already-set" }
  | { envVar: string; status: "resolved"; value: string }
  | { envVar: string; status: "unavailable"; reason: string };

function stagedFrom(
  envVar: string,
  outcome: SecretCommandResult,
):
  | { envVar: string; status: "resolved"; value: string }
  | { envVar: string; status: "unavailable"; reason: string } {
  if (outcome.ok && outcome.value !== undefined) {
    return { envVar, status: "resolved", value: outcome.value };
  }
  return {
    envVar,
    status: "unavailable",
    reason: outcome.reason ?? "unavailable",
  };
}

/**
 * Resolve every declared pointer into `env`, presence-only. Returns the
 * per-pointer outcomes (useful for tests and a boot summary). A null config
 * (no `[secrets]` section) resolves nothing. env WINS: a set var is left alone
 * and never counts as the probe. A failed resolution leaves the var unset so
 * that provider fails closed at point of use with its own clear message.
 *
 * SESSION-FIRST HYBRID (best-effort). The first pointer that needs resolving is
 * run ALONE — one invocation to establish the resolver's auth session (for a
 * session-caching manager, one unlock warms it for the followers) or to hit the
 * interactive / locked wall. Then:
 *   - probe RESOLVED: the session is warm, so the followers should reuse it
 *     rather than re-prompt — they resolve CONCURRENTLY. (A resolver that
 *     re-authenticates per invocation could still prompt; the engine cannot
 *     guarantee prompt count for a generic command.)
 *   - probe DID NOT resolve (timeout, declined unlock, or a bad first ref — not
 *     reliably distinguishable from the exit signal): the remaining pointers are
 *     marked unavailable WITHOUT being spawned. Fail-closed, no prompt-storm;
 *     total boot delay ≈ 1× timeout. This reduces likely prompts for a
 *     session-caching resolver; it is NOT an authentication determination — a
 *     bad FIRST pointer will skip the rest, so put a reliable pointer first.
 *
 * Values are written back only AFTER every resolution settles, so no resolver is
 * ever handed a secret THIS pass resolved. Each spawn also runs in an ISOLATED
 * environment (`clearEnv` + `buildResolverEnv`): only a minimal non-secret base,
 * the operator's `inherit_env` forward-list, and `[secrets.env]` — never the
 * runtime's other provider keys, database password, or memory token.
 */
export async function resolveSecretsIntoEnv(
  secrets: SecretsConfig | null,
  deps: ResolveSecretsDeps = {},
): Promise<SecretResolution[]> {
  if (secrets === null) return [];
  const env = deps.env ?? Deno.env;
  const run = deps.run ?? runSecretCommand;
  const log = deps.log ?? ((message: string) => console.error(message));
  const { command, timeoutMs } = secrets;
  // Built once: the resolver's isolated environment (minimal base + inherit_env
  // + [secrets.env]), read from the ambient env before any secret this pass
  // resolves is staged in — so a follower never receives an earlier value either.
  const cmdEnv = buildResolverEnv(secrets, env);

  const entries = Object.entries(secrets.pointers);
  const outcomes = new Map<string, StagedResolution>();
  const pending: Array<{ envVar: string; pointer: string }> = [];
  for (const [envVar, pointer] of entries) {
    const existing = env.get(envVar);
    if (existing !== undefined && existing !== "") {
      outcomes.set(envVar, { envVar, status: "already-set" });
    } else {
      pending.push({ envVar, pointer });
    }
  }

  if (pending.length > 0) {
    // The SESSION PROBE: the first pending pointer in stable declaration order
    // (never map-iteration order), run alone to warm the resolver's auth session
    // (or hit the wall). A bad-ref probe failure is therefore reproducible, not
    // intermittent.
    const probe = pending[0];
    const probeOutcome = await run(command, probe.pointer, timeoutMs, cmdEnv);
    const followers = pending.slice(1);

    if (probeOutcome.ok && probeOutcome.value !== undefined) {
      // Only a SUCCESSFUL probe establishes the session — so the followers
      // should reuse it rather than re-prompt. Burst them concurrently.
      outcomes.set(probe.envVar, {
        envVar: probe.envVar,
        status: "resolved",
        value: probeOutcome.value,
      });
      const settled = await Promise.all(
        followers.map(async (f) =>
          stagedFrom(f.envVar, await run(command, f.pointer, timeoutMs, cmdEnv))
        ),
      );
      for (const s of settled) outcomes.set(s.envVar, s);
    } else if (followers.length === 0) {
      // Sole pending pointer — no session to gate for anyone else, so report its
      // raw failure without the session-probe framing.
      outcomes.set(probe.envVar, stagedFrom(probe.envVar, probeOutcome));
    } else {
      // The probe did NOT resolve. We deliberately do NOT classify why from the
      // exit signal: a locked vault, a declined interactive unlock, and a
      // genuinely bad first ref are not reliably distinguishable (a decline
      // often exits fast and non-zero, exactly like a bad ref). So we skip the
      // rest WITHOUT spawning — fail-closed, no prompt-storm.
      // The probe's own line carries its raw failure and reads distinctly from
      // the skipped followers (which name the probe), so the operator knows the
      // one pointer to fix. Best-effort prompt/latency bound, NOT an auth
      // determination — put a reliable pointer first.
      outcomes.set(probe.envVar, {
        envVar: probe.envVar,
        status: "unavailable",
        reason: `session probe failed: ${probeOutcome.reason ?? "unavailable"}`,
      });
      for (const f of followers) {
        outcomes.set(f.envVar, {
          envVar: f.envVar,
          status: "unavailable",
          reason: `skipped: session probe ${probe.envVar} did not resolve`,
        });
      }
    }
  }

  // Emit in declaration order; apply env writes only now (staging preserved).
  const results: SecretResolution[] = [];
  for (const [envVar] of entries) {
    const s = outcomes.get(envVar)!;
    if (s.status === "already-set") {
      log(`secret ${envVar}: already-set (env wins; pointer not consulted)`);
      results.push({ envVar, status: "already-set" });
    } else if (s.status === "resolved") {
      env.set(envVar, s.value);
      log(`secret ${envVar}: resolved`);
      results.push({ envVar, status: "resolved" });
    } else {
      log(
        `secret ${envVar}: unavailable (${s.reason}); ` +
          `that provider is degraded until the pointer resolves`,
      );
      results.push({ envVar, status: "unavailable", reason: s.reason });
    }
  }
  return results;
}

/**
 * The `--allow-run` binary the resolver needs, or null when no command is
 * configured. `dyfj start` appends this to the child runtime's explicit
 * `--allow-run` (the operator-private resolver binary never belongs in the
 * committed `serve-unix` permission profile — same launch-resolved posture as
 * the `unix:<socket>` and memory-host net grants).
 */
export function secretsRunGrant(secrets: SecretsConfig | null): string | null {
  if (secrets === null || secrets.command.length === 0) return null;
  return secrets.command[0];
}
