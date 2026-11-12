import { createHash } from "node:crypto";
import {
  AcpAbortRequested,
  type AcpExecutionProfile,
  type AcpPromptInput,
  type AcpRunInput,
  type AcpRunResult,
  type AcpSessionHandle,
  DEFAULT_SESSION_TIMEOUT_MS,
  startAcpSession,
  withTimeout,
} from "./acp-client.ts";
import type { RuntimePolicy } from "./config/mod.ts";
import {
  DomainError,
  type ExternalAgentContinuityState,
  type ExternalAgentDurableResumeStatus,
} from "./contract/mod.ts";

export const DEFAULT_ACP_SESSION_CAPACITY = 8;
export const DEFAULT_ACP_IDLE_TTL_MS = 5 * 60_000;
export const DEFAULT_ACP_SHUTDOWN_TIMEOUT_MS = 8_000;

export class AcpSessionBusyError extends DomainError {
  override readonly name = "AcpSessionBusyError";
  constructor() {
    super(
      "External-agent session busy: another turn is already running on " +
        "this session. Wait for it to finish (or cancel it), then retry.",
    );
  }
}

export class AcpSessionCapacityError extends DomainError {
  override readonly name = "AcpSessionCapacityError";
  constructor() {
    super(
      "External-agent session capacity reached: too many live agent " +
        "sessions. End a session you no longer need, or restart the " +
        "runtime (`dyfj stop`, then start it), then retry.",
    );
  }
}

export class AcpSessionShutdownError extends DomainError {
  override readonly name = "AcpSessionShutdownError";
  constructor() {
    super(
      "External-agent sessions are shut down because the runtime is " +
        "stopping. Start it again with `dyfj start`, then retry.",
    );
  }
}

export interface AcpContinuityEvidence {
  state: ExternalAgentContinuityState;
  durableResume: ExternalAgentDurableResumeStatus;
}

/**
 * Decide how a turn keeps its meaning when the keyed native handle may be gone.
 *
 * The idle TTL retires handles as a resource policy, so an expired handle must
 * never silently become a fresh, empty native session presented as the same
 * conversation. A durable native resume is claimed only when BOTH the runner
 * advertises `session/load` AND the caller verified the resumed external
 * session identity; anything less reconstructs from Workbench-owned history.
 */
export function selectAcpContinuity(input: {
  /** The acquired handle is the same live handle a prior turn released. */
  warmHandleReused: boolean;
  /** The Workbench session has prior turns that must reach the runner. */
  priorTurns: boolean;
  /** Runner-reported `agentCapabilities.loadSession` from initialize. */
  agentAdvertisesSessionLoad: boolean;
  /** External session id the caller loaded AND verified against its record. */
  verifiedResumedExternalSessionId?: string;
}): AcpContinuityEvidence {
  if (input.warmHandleReused) {
    return { state: "warm-reused", durableResume: "not-required" };
  }
  if (!input.priorTurns) {
    return { state: "new", durableResume: "not-required" };
  }
  if (!input.agentAdvertisesSessionLoad) {
    return {
      state: "reconstructed",
      durableResume: "unavailable-agent-capability",
    };
  }
  if (input.verifiedResumedExternalSessionId === undefined) {
    return {
      state: "reconstructed",
      durableResume: "unavailable-client-verification",
    };
  }
  return { state: "durably-resumed", durableResume: "verified" };
}

export interface AcpSessionHandleKey {
  sessionId: string;
  workspace: string;
  profile: AcpExecutionProfile;
}

export interface AcpSessionHandleMapOptions {
  /** The run policy every session this map starts is spawned under. */
  runPolicy?: RuntimePolicy;
  capacity?: number;
  idleTtlMs?: number;
  shutdownTimeoutMs?: number;
  now?: () => number;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (id: unknown) => void;
}

type HandleState = "creating" | "idle" | "active" | "closing" | "closed";

interface MapEntry {
  key: string;
  state: HandleState;
  handle?: AcpSessionHandle;
  createPromise?: Promise<AcpSessionHandle>;
  idleGeneration: number;
  idleTimer?: unknown;
  idleDeadlineMs?: number;
  /** The close already running for this entry, if one is in progress. */
  closePromise?: Promise<void>;
}

export function canonicalExecutionProfileDigest(
  profile: AcpExecutionProfile,
): string {
  const environment = Object.fromEntries(
    Object.keys(profile.environment).sort().map((name) => [
      name,
      profile.environment[name],
    ]),
  );
  const canonical = {
    slug: profile.slug,
    command: profile.command,
    args: profile.args,
    environment,
    // Only when set, so a profile without added roots keeps its digest.
    // Read-only roots are never sent to the agent, so they are not part of
    // the key: a change of read-only roots reuses the warm session.
    ...(profile.additionalDirectories === undefined ||
        profile.additionalDirectories.length === 0
      ? {}
      : { additionalDirectories: [...profile.additionalDirectories] }),
    transport: profile.transport,
    accessRoute: profile.accessRoute,
    costBasis: profile.costBasis,
    requiredAuthentication: profile.requiredAuthentication ?? null,
    initializeTimeoutMs: profile.initializeTimeoutMs ?? null,
    sessionTimeoutMs: profile.sessionTimeoutMs ?? null,
    promptTimeoutMs: profile.promptTimeoutMs ?? null,
    cancellationTimeoutMs: profile.cancellationTimeoutMs ?? null,
    permissionVerdictTimeoutMs: profile.permissionVerdictTimeoutMs ?? null,
    terminationTimeoutMs: profile.terminationTimeoutMs ?? null,
    sessionUpdatePolicy: profile.sessionUpdatePolicy ?? null,
    protocolMessagePolicy: profile.protocolMessagePolicy ?? null,
    toolchainDirectoryCount: profile.toolchainDirectoryCount ?? null,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function encodeAcpSessionHandleKey(input: AcpSessionHandleKey): string {
  return JSON.stringify([
    input.sessionId,
    input.workspace,
    canonicalExecutionProfileDigest(input.profile),
  ]);
}

export class AcpSessionHandleMap {
  readonly #runPolicy: RuntimePolicy | undefined;
  readonly #capacity: number;
  readonly #idleTtlMs: number;
  readonly #shutdownTimeoutMs: number;
  readonly #now: () => number;
  readonly #setTimeout: (callback: () => void, ms: number) => unknown;
  readonly #clearTimeout: (id: unknown) => void;
  readonly #entries = new Map<string, MapEntry>();
  #shuttingDown = false;

  constructor(options: AcpSessionHandleMapOptions = {}) {
    this.#runPolicy = options.runPolicy;
    this.#capacity = options.capacity ?? DEFAULT_ACP_SESSION_CAPACITY;
    this.#idleTtlMs = options.idleTtlMs ?? DEFAULT_ACP_IDLE_TTL_MS;
    this.#shutdownTimeoutMs = options.shutdownTimeoutMs ??
      DEFAULT_ACP_SHUTDOWN_TIMEOUT_MS;
    this.#now = options.now ?? Date.now;
    this.#setTimeout = options.setTimeout ??
      ((callback, ms) => setTimeout(callback, ms));
    this.#clearTimeout = options.clearTimeout ??
      ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  }

  get size(): number {
    return this.#entries.size;
  }

  stateFor(input: AcpSessionHandleKey): HandleState | undefined {
    return this.#entries.get(encodeAcpSessionHandleKey(input))?.state;
  }

  async acquire(
    input: AcpSessionHandleKey & {
      create?: () => Promise<AcpSessionHandle>;
      abortSignal?: AbortSignal;
      onRouteVerified?: AcpRunInput["onRouteVerified"];
    },
  ): Promise<AcpSessionHandle> {
    const key = encodeAcpSessionHandleKey(input);
    while (true) {
      if (this.#shuttingDown) throw new AcpSessionShutdownError();
      const existing = this.#entries.get(key);
      if (existing !== undefined) {
        if (existing.state === "creating" || existing.state === "active") {
          throw new AcpSessionBusyError();
        }
        if (existing.state === "closing") throw new AcpSessionBusyError();
        if (existing.state === "idle" && existing.handle !== undefined) {
          this.#disarmIdleTimer(existing);
          if (existing.handle.isAlive) {
            existing.state = "active";
            return existing.handle;
          }
          this.#entries.delete(key);
          void existing.handle.close().catch(() => {});
        }
      }
      if (this.#entries.size < this.#capacity) break;
      const victim = this.#earliestIdleEntry();
      if (victim === undefined) {
        throw new AcpSessionCapacityError();
      }
      await this.#closeIdleForCapacity(victim);
    }
    const entry: MapEntry = { key, state: "creating", idleGeneration: 0 };
    this.#entries.set(key, entry);
    const create = input.create ??
      (() => startAcpSession({
        profile: input.profile,
        abortSignal: input.abortSignal,
        onRouteVerified: input.onRouteVerified,
        runPolicy: this.#runPolicy,
        onBroken: () => {
          if (this.#entries.get(key) !== entry) return;
          if (entry.state === "creating" || entry.state === "closing") return;
          void this.#removeAndClose(entry).catch(() => {});
        },
      }));
    const createPromise = create();
    entry.createPromise = createPromise;
    try {
      const handle = await createPromise;
      entry.handle = handle;
      if (this.#shuttingDown || this.#entries.get(key) !== entry) {
        throw new AcpSessionShutdownError();
      }
      entry.state = "active";
      return handle;
    } catch (error) {
      if (
        !(error instanceof AcpSessionShutdownError) &&
        this.#entries.get(key) === entry &&
        !this.#shuttingDown
      ) {
        this.#entries.delete(key);
      }
      throw error;
    }
  }

  release(handle: AcpSessionHandle, idleTtlMs?: number): void {
    const entry = this.#entryForHandle(handle);
    if (entry === undefined) return;
    if (entry.state !== "active") return;
    if (!handle.isAlive) {
      void this.#removeAndClose(entry).catch(() => {});
      return;
    }
    const ttlMs = idleTtlMs ?? this.#idleTtlMs;
    entry.state = "idle";
    this.#armIdleTimer(entry, ttlMs);
  }

  /**
   * Close the idle live handles for `sessionId`, and wait for a close of
   * that session that is already in progress.
   *
   * An active handle is left alone: another turn on that session is using it,
   * and closing it would cut that turn off. A one-shot turn calls this after
   * its own handle has been released to idle, while the session lock is still
   * held, so the handle it just used is idle and no other turn can take it.
   * The idle TTL can start that close first. The entry is then `closing`
   * rather than idle, and it still holds its capacity slot until the close
   * finishes. This waits for that close. A close that already failed and
   * left the handle alive is run again, not skipped. Each captured idle
   * handle is closed. Rejection handlers are attached when those closes
   * start. A close that fails does not skip the rest; the first failure is
   * reported after those attempts.
   */
  async dropSession(sessionId: string): Promise<void> {
    const waits: Promise<void>[] = [];
    for (const entry of this.#entries.values()) {
      if (sessionIdFromHandleKey(entry.key) !== sessionId) continue;
      if (entry.state === "closing") {
        // A settled failure clears closePromise and leaves the entry. Retry
        // that close. An in-progress close is joined.
        waits.push(entry.closePromise ?? this.#removeAndClose(entry));
        continue;
      }
      if (entry.state !== "idle" || entry.handle === undefined) continue;
      waits.push(this.drop(entry.handle));
    }
    const settled = await Promise.allSettled(waits);
    const failure = settled.find((result) => result.status === "rejected");
    if (failure !== undefined && failure.status === "rejected") {
      throw failure.reason;
    }
  }

  async drop(handle: AcpSessionHandle): Promise<void> {
    const entry = this.#entryForHandle(handle);
    if (entry === undefined) {
      try {
        await handle.close();
      } catch {
        // Already detached; still attempt bounded close.
      }
      return;
    }
    await this.#removeAndClose(entry);
  }

  async runTurn(
    input: AcpSessionHandleKey & AcpPromptInput & {
      create?: () => Promise<AcpSessionHandle>;
      onRouteVerified?: AcpRunInput["onRouteVerified"];
      /** Idle limit in milliseconds applied when this turn releases the handle. */
      idleTtlMs?: number;
      /**
       * Bounded projection of the Workbench session's prior turns, supplied
       * only when the session has history to carry. Called just once, and only
       * when the acquired handle is NOT the warm one — so a live handle keeps
       * its own inner history and nothing is replayed into it. Throwing here
       * fails the turn before any prompt reaches the agent.
       */
      reconstructPrompt?: () => string;
      /** Observed continuity for this turn, reported before the prompt. */
      onContinuity?: (evidence: AcpContinuityEvidence) => void;
    },
  ): Promise<AcpRunResult> {
    const startedAt = this.#now();
    const abortedResult = (): AcpRunResult => ({
      text: "",
      stopReason: "aborted",
      protocolVersion: undefined,
      externalSessionId: undefined,
      capabilities: [],
      elapsedMs: this.#now() - startedAt,
    });
    const key = encodeAcpSessionHandleKey(input);
    const prior = this.#entries.get(key);
    const idleHandle = prior?.state === "idle" ? prior.handle : undefined;
    let handle: AcpSessionHandle;
    try {
      handle = await this.acquire(input);
    } catch (error) {
      if (isTurnAborted(error)) return abortedResult();
      throw error;
    }
    const reused = idleHandle !== undefined && handle === idleHandle;
    try {
      if (
        reused &&
        input.onRouteVerified !== undefined &&
        handle.routeEvidence !== undefined
      ) {
        if (input.abortSignal?.aborted) return abortedResult();
        const replayController = new AbortController();
        const forwardAbort = () => replayController.abort();
        input.abortSignal?.addEventListener("abort", forwardAbort, {
          once: true,
        });
        if (input.abortSignal?.aborted) replayController.abort();
        try {
          if (replayController.signal.aborted) return abortedResult();
          const replay = Promise.resolve(input.onRouteVerified(
            handle.routeEvidence,
            replayController.signal,
          ));
          void replay.catch(() => {});
          await withTimeout(
            replay,
            input.profile.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS,
            "authenticate",
          );
        } finally {
          replayController.abort();
          input.abortSignal?.removeEventListener("abort", forwardAbort);
        }
      }
      // Decide continuity against the handle actually acquired, not against an
      // earlier probe: an idle handle can be retired between the two, and that
      // race is exactly how a follow-up loses its antecedent.
      const continuity = selectAcpContinuity({
        warmHandleReused: reused,
        priorTurns: input.reconstructPrompt !== undefined,
        agentAdvertisesSessionLoad: handle.durableSessionLoad,
      });
      const prompt = continuity.state === "reconstructed"
        ? input.reconstructPrompt!()
        : input.prompt;
      input.onContinuity?.(continuity);
      return await handle.prompt({ ...input, prompt });
    } catch (error) {
      if (isTurnAborted(error)) return abortedResult();
      await this.drop(handle);
      throw error;
    } finally {
      this.release(handle, input.idleTtlMs);
    }
  }

  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    const entries = [...this.#entries.values()];
    const closes = entries.map((entry) => this.#closeForShutdown(entry));
    let timer: unknown;
    try {
      const settled = await Promise.race([
        Promise.allSettled(closes),
        new Promise<never>((_, reject) => {
          timer = this.#setTimeout(() => {
            reject(new Error("ACP session map shutdown timed out"));
          }, this.#shutdownTimeoutMs);
        }),
      ]);
      const failure = settled.find((result) => result.status === "rejected");
      if (failure !== undefined && failure.status === "rejected") {
        throw failure.reason;
      }
    } finally {
      if (timer !== undefined) this.#clearTimeout(timer);
    }
  }

  #entryForHandle(handle: AcpSessionHandle): MapEntry | undefined {
    for (const entry of this.#entries.values()) {
      if (entry.handle === handle) return entry;
    }
    return undefined;
  }

  #earliestIdleEntry(): MapEntry | undefined {
    let earliest: MapEntry | undefined;
    for (const entry of this.#entries.values()) {
      if (entry.state !== "idle") continue;
      if (
        earliest === undefined ||
        (entry.idleDeadlineMs ?? Infinity) <
          (earliest.idleDeadlineMs ?? Infinity)
      ) {
        earliest = entry;
      }
    }
    return earliest;
  }

  async #closeIdleForCapacity(entry: MapEntry): Promise<void> {
    const close = this.#removeAndClose(entry);
    let timer: unknown;
    try {
      await Promise.race([
        close,
        new Promise<never>((_, reject) => {
          timer = this.#setTimeout(() => {
            reject(new AcpSessionCapacityError());
          }, this.#shutdownTimeoutMs);
        }),
      ]);
    } catch {
      throw new AcpSessionCapacityError();
    } finally {
      if (timer !== undefined) this.#clearTimeout(timer);
    }
    console.error(
      "[acp-session-map] closed idle external-agent session for capacity",
    );
  }

  #armIdleTimer(entry: MapEntry, idleTtlMs: number = this.#idleTtlMs): void {
    this.#disarmIdleTimer(entry);
    const generation = ++entry.idleGeneration;
    entry.idleDeadlineMs = this.#now() + idleTtlMs;
    entry.idleTimer = this.#setTimeout(() => {
      void this.#onIdleTimeout(entry, generation).catch(() => {});
    }, idleTtlMs);
  }

  #disarmIdleTimer(entry: MapEntry): void {
    entry.idleDeadlineMs = undefined;
    if (entry.idleTimer === undefined) return;
    this.#clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
    entry.idleGeneration += 1;
  }

  async #onIdleTimeout(entry: MapEntry, generation: number): Promise<void> {
    if (this.#entries.get(entry.key) !== entry) return;
    if (entry.idleGeneration !== generation) return;
    if (entry.state !== "idle") return;
    await this.#removeAndClose(entry);
  }

  async #closeForShutdown(entry: MapEntry): Promise<void> {
    if (entry.createPromise !== undefined) {
      try {
        entry.handle ??= await entry.createPromise;
      } catch {
        // Creation failed; acquire already reaped partial resources.
      }
    }
    await this.#removeAndClose(entry);
  }

  /**
   * One close per entry while it is running. A later call joins that close
   * instead of starting another. After it settles, a new call can run again,
   * which is how shutdown retries a close that left the handle alive.
   */
  #removeAndClose(entry: MapEntry): Promise<void> {
    if (entry.closePromise !== undefined) return entry.closePromise;
    const promise = this.#performClose(entry);
    entry.closePromise = promise;
    const clear = () => {
      if (entry.closePromise === promise) entry.closePromise = undefined;
    };
    // Both outcomes are handled here so a failed close is not a second,
    // unhandled rejection on top of the caller's own wait.
    void promise.then(clear, clear);
    return promise;
  }

  async #performClose(entry: MapEntry): Promise<void> {
    this.#disarmIdleTimer(entry);
    if (entry.state === "closed") return;
    if (this.#entries.get(entry.key) === entry && entry.state !== "closing") {
      entry.state = "closing";
    }
    try {
      if (entry.handle !== undefined) await entry.handle.close();
    } catch (error) {
      if (entry.handle?.isAlive === true) throw error;
      entry.state = "closed";
      if (this.#entries.get(entry.key) === entry) {
        this.#entries.delete(entry.key);
      }
      throw error;
    }
    entry.state = "closed";
    if (this.#entries.get(entry.key) === entry) {
      this.#entries.delete(entry.key);
    }
  }
}

function sessionIdFromHandleKey(key: string): string | undefined {
  try {
    const parsed = JSON.parse(key) as unknown;
    if (!Array.isArray(parsed) || typeof parsed[0] !== "string") {
      return undefined;
    }
    return parsed[0];
  } catch {
    return undefined;
  }
}

function isTurnAborted(error: unknown): boolean {
  if (error instanceof AcpAbortRequested) return true;
  return error instanceof Error && error.name === "AbortError";
}
