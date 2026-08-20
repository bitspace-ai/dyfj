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
} from "./acp-client";
import { DomainError } from "./turn-contract";

export const DEFAULT_ACP_SESSION_CAPACITY = 8;
export const DEFAULT_ACP_IDLE_TTL_MS = 5 * 60_000;
export const DEFAULT_ACP_SHUTDOWN_TIMEOUT_MS = 8_000;

export class AcpSessionBusyError extends DomainError {
  override readonly name = "AcpSessionBusyError";
  constructor() {
    super("session busy");
  }
}

export class AcpSessionCapacityError extends DomainError {
  override readonly name = "AcpSessionCapacityError";
  constructor() {
    super("ACP session capacity reached");
  }
}

export class AcpSessionShutdownError extends DomainError {
  override readonly name = "AcpSessionShutdownError";
  constructor() {
    super("ACP session map is shut down");
  }
}

export interface AcpSessionHandleKey {
  sessionId: string;
  workspace: string;
  profile: AcpExecutionProfile;
}

export interface AcpSessionHandleMapOptions {
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
  readonly #capacity: number;
  readonly #idleTtlMs: number;
  readonly #shutdownTimeoutMs: number;
  readonly #now: () => number;
  readonly #setTimeout: (callback: () => void, ms: number) => unknown;
  readonly #clearTimeout: (id: unknown) => void;
  readonly #entries = new Map<string, MapEntry>();
  #shuttingDown = false;

  constructor(options: AcpSessionHandleMapOptions = {}) {
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
    if (this.#shuttingDown) throw new AcpSessionShutdownError();
    const key = encodeAcpSessionHandleKey(input);
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
    if (this.#entries.size >= this.#capacity) {
      throw new AcpSessionCapacityError();
    }
    const entry: MapEntry = { key, state: "creating", idleGeneration: 0 };
    this.#entries.set(key, entry);
    const create = input.create ??
      (() => startAcpSession({
        profile: input.profile,
        abortSignal: input.abortSignal,
        onRouteVerified: input.onRouteVerified,
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

  release(handle: AcpSessionHandle): void {
    const entry = this.#entryForHandle(handle);
    if (entry === undefined) return;
    if (entry.state !== "active") return;
    if (!handle.isAlive) {
      void this.#removeAndClose(entry).catch(() => {});
      return;
    }
    entry.state = "idle";
    this.#armIdleTimer(entry);
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
    },
  ): Promise<AcpRunResult> {
    const startedAt = Date.now();
    const abortedResult = (): AcpRunResult => ({
      text: "",
      stopReason: "aborted",
      protocolVersion: undefined,
      externalSessionId: undefined,
      capabilities: [],
      elapsedMs: Date.now() - startedAt,
    });
    const reused =
      this.#entries.get(encodeAcpSessionHandleKey(input))?.state === "idle";
    let handle: AcpSessionHandle;
    try {
      handle = await this.acquire(input);
    } catch (error) {
      if (isTurnAborted(error)) return abortedResult();
      throw error;
    }
    try {
      if (
        reused &&
        input.onRouteVerified !== undefined &&
        handle.routeEvidence !== undefined
      ) {
        if (input.abortSignal?.aborted) return abortedResult();
        await withTimeout(
          Promise.resolve(input.onRouteVerified(
            handle.routeEvidence,
            input.abortSignal ?? new AbortController().signal,
          )),
          input.profile.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS,
          "authenticate",
        );
      }
      return await handle.prompt(input);
    } catch (error) {
      if (isTurnAborted(error)) return abortedResult();
      await this.drop(handle);
      throw error;
    } finally {
      this.release(handle);
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

  #armIdleTimer(entry: MapEntry): void {
    this.#disarmIdleTimer(entry);
    const generation = ++entry.idleGeneration;
    entry.idleTimer = this.#setTimeout(() => {
      void this.#onIdleTimeout(entry, generation).catch(() => {});
    }, this.#idleTtlMs);
  }

  #disarmIdleTimer(entry: MapEntry): void {
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

  async #removeAndClose(entry: MapEntry): Promise<void> {
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

function isTurnAborted(error: unknown): boolean {
  if (error instanceof AcpAbortRequested) return true;
  return error instanceof Error && error.name === "AbortError";
}
