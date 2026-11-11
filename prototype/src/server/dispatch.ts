// Dispatched child sessions (BIT-907): the runtime service behind the four
// coordinator tools (`dispatch/start`, `dispatch/wait`, `dispatch/read` and
// `dispatch/send`).
//
// This service is the single writer of live child state per coordinator
// session. Child turns run headless (`HeadlessTurns`) under `ParkedApprovals`,
// never under the coordinator's client approver. Width counts children in
// `running`, `awaiting_approval` or `idle`, releasing `idle` slots after 30
// minutes (the same way an idle external-agent handle is released).

import { createHash } from "node:crypto";
import {
  type CodexReasoningEffort,
  type DispatchConfig,
  type Env,
  processEnv,
} from "../config/mod.ts";
import {
  type DispatchRecord,
  DomainError,
  summarizeError,
  type WorkbenchAuthContext,
  type WorkbenchRuntimeEvent,
  type WorkbenchSessionEvent,
} from "../contract/mod.ts";
import type { DispatchEnginePorts } from "../engine/mod.ts";
import {
  type Clock,
  generateSpanId,
  generateULID,
  sanitizeBoundaryText,
  systemClock,
} from "../kernel/mod.ts";
import { loadWorkbenchModels, type WorkbenchModel } from "../providers/mod.ts";
import { dispatchStartedEvent, type Store } from "../store/mod.ts";
import {
  CommandExecutionError,
  DISPATCH_LABEL_PATTERN,
  type DispatchChildState,
  type DispatchReadInput,
  type DispatchReadResult,
  type DispatchSendInput,
  type DispatchSendResult,
  type DispatchSessionPorts,
  type DispatchSettledChild,
  type DispatchStartInput,
  type DispatchStartPlan,
  type DispatchStartResult,
  type DispatchWaitInput,
  type DispatchWaitResult,
  projectChildTurnsForRead,
  renderCoordinatorMessage,
} from "../tools/mod.ts";
import {
  buildChildTurnBody,
  classifyTurnFailure,
  classifyTurnReceipt,
  planDispatchStart,
} from "./dispatch-plan.ts";
import type { HeadlessTurn, HeadlessTurns } from "./headless-turn.ts";
import type {
  ParkedApprovalChange,
  ParkedApprovals,
} from "./parked-approvals.ts";

/** Idle release horizon for a dispatched child slot: 30 minutes. */
export const DEFAULT_DISPATCH_IDLE_TTL_MS = 30 * 60_000;

export interface DispatchServerOptions {
  config: DispatchConfig;
  clock?: Clock;
  idleTtlMs?: number;
}

export interface DispatchServiceDeps {
  config: DispatchConfig;
  store: () => Store;
  headlessTurns: () => HeadlessTurns;
  parkedApprovals: ParkedApprovals;
  fetchSessionEvents: (
    input: { sessionId: string },
  ) => Promise<WorkbenchSessionEvent[]>;
  loadModels?: () => Promise<WorkbenchModel[]>;
  releaseExternalAgentSession?: (sessionId: string) => Promise<void>;
  notifySessionEvent?: (
    sessionId: string,
    event: WorkbenchRuntimeEvent,
  ) => void;
  env?: Env;
  trustWorkspaceInstructions?: boolean;
  defaultCodexReasoningEffort?: CodexReasoningEffort;
  clock?: Clock;
  idleTtlMs?: number;
}

interface CoordinatorContext {
  parentSessionId: string;
  traceId: string;
  turnRootSpanId: string;
  principalId: string;
  authContext: WorkbenchAuthContext;
  depth: number;
  abortSignal?: AbortSignal;
}

interface StartingReservation {
  label: string;
  workspace: string;
}

interface ChildEntry {
  readonly sessionId: string;
  readonly parentSessionId: string;
  readonly label: string;
  readonly model: string;
  readonly effort: string | null;
  readonly route: "native" | "acp";
  readonly family: string;
  readonly workspace: string;
  readonly roots: readonly string[];
  readonly approvePaid: boolean;
  state: DispatchChildState;
  turnInFlight: boolean;
  released: boolean;
  idleSinceMs: number | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

function isLiveChild(entry: ChildEntry): boolean {
  if (entry.state === "running" || entry.state === "awaiting_approval") {
    return true;
  }
  return entry.state === "idle" && !entry.released;
}

export class DispatchService implements DispatchEnginePorts {
  readonly #config: DispatchConfig;
  readonly #store: () => Store;
  readonly #headlessTurns: () => HeadlessTurns;
  readonly #parkedApprovals: ParkedApprovals;
  readonly #fetchSessionEvents: DispatchServiceDeps["fetchSessionEvents"];
  readonly #loadModels?: () => Promise<WorkbenchModel[]>;
  readonly #releaseExternalAgentSession?: (sessionId: string) => Promise<void>;
  readonly #notifySessionEvent?: (
    sessionId: string,
    event: WorkbenchRuntimeEvent,
  ) => void;
  readonly #env: Env;
  readonly #trustWorkspaceInstructions: boolean;
  readonly #defaultCodexReasoningEffort: CodexReasoningEffort;
  readonly #clock: Clock;
  readonly #idleTtlMs: number;
  readonly #unsubscribeParked: () => void;

  readonly #childrenByCoordinator = new Map<string, ChildEntry[]>();
  readonly #byChildSessionId = new Map<string, ChildEntry>();
  readonly #startingByCoordinator = new Map<string, Set<StartingReservation>>();
  readonly #waitersByCoordinator = new Map<string, Set<() => void>>();
  #closed = false;

  constructor(deps: DispatchServiceDeps) {
    this.#config = deps.config;
    this.#store = deps.store;
    this.#headlessTurns = deps.headlessTurns;
    this.#parkedApprovals = deps.parkedApprovals;
    this.#fetchSessionEvents = deps.fetchSessionEvents;
    this.#loadModels = deps.loadModels;
    this.#releaseExternalAgentSession = deps.releaseExternalAgentSession;
    this.#notifySessionEvent = deps.notifySessionEvent;
    this.#env = deps.env ?? processEnv;
    this.#trustWorkspaceInstructions = deps.trustWorkspaceInstructions === true;
    this.#defaultCodexReasoningEffort =
      deps.defaultCodexReasoningEffort ?? "medium";
    this.#clock = deps.clock ?? systemClock;
    this.#idleTtlMs = deps.idleTtlMs ?? DEFAULT_DISPATCH_IDLE_TTL_MS;

    this.#unsubscribeParked = this.#parkedApprovals.subscribe((change) => {
      this.#onParkedApprovalChange(change);
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribeParked();
    for (const entry of this.#byChildSessionId.values()) {
      this.#clearIdleTimer(entry);
    }
    this.#waitersByCoordinator.clear();
  }

  forSession(
    context: CoordinatorContext,
  ): DispatchSessionPorts | undefined {
    if (this.#closed || context.depth !== 0) return undefined;
    return {
      config: this.#config,
      depth: context.depth,
      abortSignal: context.abortSignal,
      checkStart: (input) => this.#checkStart(context, input),
      start: (input) => this.#start(context, input),
      wait: (input, signal) => this.#wait(context, input, signal),
      read: (input) => this.#read(context, input),
      checkSend: (child) => this.#checkSend(context, child),
      send: (input) => this.#send(context, input),
    };
  }

  #onParkedApprovalChange(change: ParkedApprovalChange): void {
    if (this.#closed) return;
    const entry = this.#byChildSessionId.get(change.sessionId);
    if (entry === undefined || !entry.turnInFlight) return;
    if (change.hasPending) {
      const changed = entry.state !== "awaiting_approval";
      entry.state = "awaiting_approval";
      if (change.newlyParked) {
        this.#notifySessionEvent?.(entry.parentSessionId, {
          type: "childApprovalParked",
          sessionId: entry.parentSessionId,
          childSessionId: entry.sessionId,
          label: entry.label,
        });
      }
      if (changed || change.newlyParked) {
        this.#wakeWaiters(entry.parentSessionId);
      }
      return;
    }
    if (entry.state === "awaiting_approval") {
      entry.state = "running";
      this.#wakeWaiters(entry.parentSessionId);
    }
  }

  #sweepIdle(parentSessionId?: string): void {
    const now = this.#clock.now();
    const lists = parentSessionId === undefined
      ? this.#childrenByCoordinator.values()
      : [this.#childrenByCoordinator.get(parentSessionId) ?? []];
    for (const entries of lists) {
      for (const entry of entries) {
        if (
          entry.state === "idle" &&
          !entry.released &&
          entry.idleSinceMs !== null &&
          now - entry.idleSinceMs >= this.#idleTtlMs
        ) {
          this.#releaseIdleSlot(entry);
        }
      }
    }
  }

  #releaseIdleSlot(entry: ChildEntry): void {
    if (entry.released) return;
    entry.released = true;
    this.#clearIdleTimer(entry);
    void this.#releaseExternalAgentSession?.(entry.sessionId).catch(() => {});
  }

  #armIdleTimer(entry: ChildEntry): void {
    this.#clearIdleTimer(entry);
    entry.idleSinceMs = this.#clock.now();
    if (this.#idleTtlMs <= 0) {
      this.#releaseIdleSlot(entry);
      return;
    }
    const timer = setTimeout(() => {
      if (this.#closed) return;
      if (entry.state === "idle" && !entry.released) {
        this.#releaseIdleSlot(entry);
      }
    }, this.#idleTtlMs);
    timer.unref?.();
    entry.idleTimer = timer;
  }

  #clearIdleTimer(entry: ChildEntry): void {
    if (entry.idleTimer !== null) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }

  #liveChildren(parentSessionId: string): ChildEntry[] {
    this.#sweepIdle(parentSessionId);
    const entries = this.#childrenByCoordinator.get(parentSessionId) ?? [];
    return entries.filter(isLiveChild);
  }

  #startingReservations(parentSessionId: string): Set<StartingReservation> {
    return this.#startingByCoordinator.get(parentSessionId) ?? new Set();
  }

  #findChildByLabel(
    parentSessionId: string,
    label: string,
  ): ChildEntry | undefined {
    this.#sweepIdle(parentSessionId);
    const entries = this.#childrenByCoordinator.get(parentSessionId);
    if (entries === undefined || entries.length === 0) return undefined;
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if (entries[i].label === label && isLiveChild(entries[i])) {
        return entries[i];
      }
    }
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if (entries[i].label === label) {
        return entries[i];
      }
    }
    return undefined;
  }

  #allActiveChildrenForWait(parentSessionId: string): ChildEntry[] {
    this.#sweepIdle(parentSessionId);
    const entries = this.#childrenByCoordinator.get(parentSessionId) ?? [];
    const latestByLabel = new Map<string, ChildEntry>();
    for (const entry of entries) {
      if (entry.released) continue;
      latestByLabel.set(entry.label, entry);
    }
    return [...latestByLabel.values()];
  }

  #wakeWaiters(parentSessionId: string): void {
    const waiters = this.#waitersByCoordinator.get(parentSessionId);
    if (waiters === undefined || waiters.size === 0) return;
    for (const wake of [...waiters]) {
      wake();
    }
  }

  async #resolveCatalog(): Promise<WorkbenchModel[]> {
    if (this.#loadModels !== undefined) {
      return await this.#loadModels();
    }
    return await loadWorkbenchModels(this.#store().models);
  }

  async #checkStart(
    context: CoordinatorContext,
    input: DispatchStartInput,
  ): Promise<{ plan: DispatchStartPlan } | { refusal: string }> {
    if (this.#closed) {
      return { refusal: "the runtime is shutting down" };
    }
    if (context.depth !== 0) {
      return {
        refusal: "child sessions cannot dispatch further child sessions",
      };
    }
    if (!DISPATCH_LABEL_PATTERN.test(input.label)) {
      return { refusal: "label must match ^[a-z0-9][a-z0-9-]{0,31}$" };
    }

    const live = this.#liveChildren(context.parentSessionId);
    const starting = this.#startingReservations(context.parentSessionId);
    if (live.length + starting.size >= this.#config.maxChildren) {
      return {
        refusal:
          `dispatch width limit reached (${this.#config.maxChildren} live ` +
          "children per coordinator session)",
      };
    }
    if (
      live.some((child) => child.label === input.label) ||
      [...starting].some((item) => item.label === input.label)
    ) {
      return {
        refusal:
          `child label "${sanitizeBoundaryText(input.label, 64)}" is already ` +
          "in use by a live child of this coordinator",
      };
    }

    const occupiedWorkspaces = new Set<string>([
      ...live.map((child) => child.workspace),
      ...[...starting].map((item) => item.workspace),
    ]);

    return await planDispatchStart({
      config: this.#config,
      env: this.#env,
      input,
      loadCatalog: () => this.#resolveCatalog(),
      occupiedWorkspaces,
      trustWorkspaceInstructions: this.#trustWorkspaceInstructions,
      defaultCodexReasoningEffort: this.#defaultCodexReasoningEffort,
    });
  }

  async #commitDispatchStarted(
    context: CoordinatorContext,
    childSessionId: string,
    plan: DispatchStartPlan,
    dispatchRecord: DispatchRecord,
  ): Promise<void> {
    const coordinatorPayload = JSON.stringify({
      childSessionId,
      ...dispatchRecord,
    });
    await this.#store().journal.commit({
      events: [
        dispatchStartedEvent({
          event_id: generateULID(),
          session_id: context.parentSessionId,
          trace_id: context.traceId,
          span_id: generateSpanId(),
          parent_span_id: context.turnRootSpanId,
          principal_id: context.principalId,
          principal_type: "agent",
          action: "dispatch",
          resource: childSessionId,
          authz_basis: context.authContext.authzBasis,
          authn_status: context.authContext.authnStatus,
          authn_mechanism: context.authContext.authnMechanism,
          authn_issuer_ref: context.authContext.authnIssuerRef,
          lineage_depth: 1,
          lineage_label: plan.label,
          model_id: plan.model,
          reasoning_effort: plan.effort,
          turn_route: plan.route,
          model_family: plan.family,
          tool_arguments: coordinatorPayload,
          content: coordinatorPayload,
        }),
      ],
    });
  }

  async #start(
    context: CoordinatorContext,
    input: DispatchStartInput,
  ): Promise<DispatchStartResult> {
    const checked = await this.#checkStart(context, input);
    if ("refusal" in checked) {
      throw new CommandExecutionError(checked.refusal);
    }
    const { plan } = checked;

    let startingSet = this.#startingByCoordinator.get(context.parentSessionId);
    if (startingSet === undefined) {
      startingSet = new Set();
      this.#startingByCoordinator.set(context.parentSessionId, startingSet);
    }
    const reservation: StartingReservation = {
      label: plan.label,
      workspace: plan.workspace,
    };
    startingSet.add(reservation);

    const taskSha256 = createHash("sha256")
      .update(input.task, "utf8")
      .digest("hex");
    const dispatchRecord: DispatchRecord = {
      parentSessionId: context.parentSessionId,
      depth: 1,
      label: plan.label,
      model: plan.model,
      effort: plan.effort,
      route: plan.route,
      family: plan.family,
      workspace: plan.workspace,
      roots: [...plan.roots],
      taskSha256,
    };
    const body = buildChildTurnBody({
      prompt: renderCoordinatorMessage({
        fromSessionId: context.parentSessionId,
        text: input.task,
      }),
      workspace: plan.workspace,
      roots: plan.roots,
      model: plan.model,
      route: plan.route,
      effort: plan.effort,
      approvePaid: plan.approvePaid,
    });

    let registeredEntry: ChildEntry | undefined;
    const registerChild = (childSessionId: string): ChildEntry => {
      if (registeredEntry !== undefined) return registeredEntry;
      const entry: ChildEntry = {
        sessionId: childSessionId,
        parentSessionId: context.parentSessionId,
        label: plan.label,
        model: plan.model,
        effort: plan.effort,
        route: plan.route,
        family: plan.family,
        workspace: plan.workspace,
        roots: [...plan.roots],
        approvePaid: plan.approvePaid,
        state: this.#parkedApprovals.hasPending(childSessionId)
          ? "awaiting_approval"
          : "running",
        turnInFlight: true,
        released: false,
        idleSinceMs: null,
        idleTimer: null,
      };
      registeredEntry = entry;
      this.#byChildSessionId.set(childSessionId, entry);
      let list = this.#childrenByCoordinator.get(context.parentSessionId);
      if (list === undefined) {
        list = [];
        this.#childrenByCoordinator.set(context.parentSessionId, list);
      }
      list.push(entry);
      startingSet.delete(reservation);
      if (startingSet.size === 0) {
        this.#startingByCoordinator.delete(context.parentSessionId);
      }
      return entry;
    };

    try {
      const started = this.#headlessTurns().start(body, {
        dispatchRecord,
        onSessionRecorded: (childSessionId) => {
          registerChild(childSessionId);
        },
      });
      if ("error" in started) {
        throw new CommandExecutionError(started.error);
      }
      const childSessionId = await started.recorded;
      const entry = registerChild(childSessionId);
      this.#attachTurnSettlement(entry, started);
      await this.#commitDispatchStarted(
        context,
        childSessionId,
        plan,
        dispatchRecord,
      );

      return {
        child: { sessionId: childSessionId, label: plan.label },
        model: plan.model,
        effort: plan.effort,
        route: plan.route,
        family: plan.family,
        workspace: plan.workspace,
        state: "running",
      };
    } catch (error) {
      startingSet.delete(reservation);
      if (startingSet.size === 0) {
        this.#startingByCoordinator.delete(context.parentSessionId);
      }
      if (error instanceof CommandExecutionError) throw error;
      if (error instanceof DomainError) {
        throw new CommandExecutionError(error.message);
      }
      throw new CommandExecutionError(
        `failed to start child "${sanitizeBoundaryText(plan.label, 64)}": ${
          summarizeError(error)
        }`,
      );
    }
  }

  #attachTurnSettlement(entry: ChildEntry, turn: HeadlessTurn): void {
    void turn.result.then(
      (receipt) => {
        entry.turnInFlight = false;
        const next = classifyTurnReceipt(receipt);
        entry.state = next;
        if (next === "idle") {
          this.#armIdleTimer(entry);
        } else {
          this.#clearIdleTimer(entry);
          void this.#releaseExternalAgentSession?.(entry.sessionId).catch(
            () => {},
          );
        }
        this.#wakeWaiters(entry.parentSessionId);
      },
      (error: unknown) => {
        entry.turnInFlight = false;
        entry.state = classifyTurnFailure(error, turn.ticket.signal.aborted);
        this.#clearIdleTimer(entry);
        void this.#releaseExternalAgentSession?.(entry.sessionId).catch(
          () => {},
        );
        this.#wakeWaiters(entry.parentSessionId);
      },
    );
  }

  #resolveWaitTargets(
    parentSessionId: string,
    children: DispatchWaitInput["children"],
  ): ChildEntry[] {
    if (children === "all") {
      return this.#allActiveChildrenForWait(parentSessionId);
    }
    const resolved: ChildEntry[] = [];
    const seen = new Set<string>();
    for (const label of children) {
      if (seen.has(label)) continue;
      seen.add(label);
      const entry = this.#findChildByLabel(parentSessionId, label);
      if (entry === undefined) {
        throw new CommandExecutionError(
          `unknown child "${sanitizeBoundaryText(label, 64)}"`,
        );
      }
      resolved.push(entry);
    }
    return resolved;
  }

  #partitionTargets(targets: readonly ChildEntry[]): {
    settled: DispatchSettledChild[];
    pending: string[];
  } {
    const settled: DispatchSettledChild[] = [];
    const pending: string[] = [];
    for (const entry of targets) {
      const effectiveState: DispatchChildState =
        entry.turnInFlight && this.#parkedApprovals.hasPending(entry.sessionId)
          ? "awaiting_approval"
          : entry.state;
      if (effectiveState === "running") {
        pending.push(entry.label);
      } else {
        settled.push({
          label: entry.label,
          sessionId: entry.sessionId,
          state: effectiveState,
        });
      }
    }
    return { settled, pending };
  }

  async #wait(
    context: CoordinatorContext,
    input: DispatchWaitInput,
    signal?: AbortSignal,
  ): Promise<DispatchWaitResult> {
    if (context.depth !== 0) {
      throw new CommandExecutionError(
        "child sessions cannot wait on dispatched children",
      );
    }
    if (
      !Number.isInteger(input.timeoutSeconds) ||
      input.timeoutSeconds < 1 ||
      input.timeoutSeconds > this.#config.maxWaitSeconds
    ) {
      throw new CommandExecutionError(
        `timeoutSeconds must be an integer between 1 and ${this.#config.maxWaitSeconds}`,
      );
    }

    const effectiveSignal = signal ?? context.abortSignal;
    effectiveSignal?.throwIfAborted();

    const targets = this.#resolveWaitTargets(
      context.parentSessionId,
      input.children,
    );
    const isSatisfied = (partition: {
      settled: DispatchSettledChild[];
      pending: string[];
    }): boolean => {
      if (targets.length === 0) return true;
      return input.mode === "any"
        ? partition.settled.length > 0
        : partition.pending.length === 0;
    };

    const initial = this.#partitionTargets(targets);
    if (isSatisfied(initial)) {
      return { ...initial, timedOut: false };
    }

    return await new Promise<DispatchWaitResult>((resolve, reject) => {
      let finished = false;
      let waiterSet = this.#waitersByCoordinator.get(context.parentSessionId);
      if (waiterSet === undefined) {
        waiterSet = new Set();
        this.#waitersByCoordinator.set(context.parentSessionId, waiterSet);
      }

      const cleanup = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        effectiveSignal?.removeEventListener("abort", onAbort);
        const current = this.#waitersByCoordinator.get(context.parentSessionId);
        if (current !== undefined) {
          current.delete(onStateChange);
          if (current.size === 0) {
            this.#waitersByCoordinator.delete(context.parentSessionId);
          }
        }
      };

      const onStateChange = () => {
        const next = this.#partitionTargets(targets);
        if (!isSatisfied(next)) return;
        cleanup();
        resolve({ ...next, timedOut: false });
      };

      const onAbort = () => {
        cleanup();
        reject(
          effectiveSignal?.reason instanceof Error
            ? effectiveSignal.reason
            : new DOMException("The operation was aborted.", "AbortError"),
        );
      };

      const timer = setTimeout(() => {
        const current = this.#partitionTargets(targets);
        cleanup();
        resolve({
          ...current,
          timedOut: !isSatisfied(current),
        });
      }, input.timeoutSeconds * 1000);

      waiterSet.add(onStateChange);
      effectiveSignal?.addEventListener("abort", onAbort, { once: true });
      if (effectiveSignal?.aborted) {
        onAbort();
        return;
      }
      onStateChange();
    });
  }

  async #read(
    context: CoordinatorContext,
    input: DispatchReadInput,
  ): Promise<DispatchReadResult> {
    if (context.depth !== 0) {
      throw new CommandExecutionError(
        "child sessions cannot read dispatched children",
      );
    }
    const entry = this.#findChildByLabel(context.parentSessionId, input.child);
    if (entry === undefined) {
      throw new CommandExecutionError(
        `unknown child "${sanitizeBoundaryText(input.child, 64)}"`,
      );
    }

    const events = await this.#fetchSessionEvents({ sessionId: entry.sessionId });
    const turns = projectChildTurnsForRead(events, {
      turns: input.turns,
      includeToolEvents: input.toolEvents,
    });
    const effectiveState: DispatchChildState =
      entry.turnInFlight && this.#parkedApprovals.hasPending(entry.sessionId)
        ? "awaiting_approval"
        : entry.state;

    return {
      origin: "child_session",
      child: {
        sessionId: entry.sessionId,
        label: entry.label,
        parentSessionId: entry.parentSessionId,
      },
      model: entry.model,
      effort: entry.effort,
      route: entry.route,
      family: entry.family,
      state: effectiveState,
      turns,
    };
  }

  async #checkSend(
    context: CoordinatorContext,
    childLabel: string,
  ): Promise<string | null> {
    if (this.#closed) return "the runtime is shutting down";
    if (context.depth !== 0) {
      return "child sessions cannot send messages to dispatched children";
    }
    const entry = this.#findChildByLabel(context.parentSessionId, childLabel);
    if (entry === undefined) {
      return `unknown child "${sanitizeBoundaryText(childLabel, 64)}"`;
    }
    const safeLabel = sanitizeBoundaryText(entry.label, 64);
    if (
      entry.state === "awaiting_approval" ||
      this.#parkedApprovals.hasPending(entry.sessionId)
    ) {
      return (
        `child "${safeLabel}" is waiting for operator approval; nothing was ` +
        `sent (answer via dyfj --session ${entry.sessionId})`
      );
    }
    if (entry.turnInFlight || entry.state === "running") {
      return `child "${safeLabel}" is currently running a turn`;
    }
    if (entry.released) {
      return (
        `child "${safeLabel}" is no longer live (released after 30 minutes ` +
        "idle)"
      );
    }
    if (entry.state !== "idle") {
      return `child "${safeLabel}" is ${entry.state} and cannot accept a follow-up`;
    }
    return null;
  }

  async #send(
    context: CoordinatorContext,
    input: DispatchSendInput,
  ): Promise<DispatchSendResult> {
    const refusal = await this.#checkSend(context, input.child);
    if (refusal !== null) {
      throw new CommandExecutionError(refusal);
    }
    const entry = this.#findChildByLabel(context.parentSessionId, input.child);
    if (entry === undefined) {
      throw new CommandExecutionError(
        `unknown child "${sanitizeBoundaryText(input.child, 64)}"`,
      );
    }

    this.#clearIdleTimer(entry);
    entry.state = "running";
    entry.turnInFlight = true;

    const body = buildChildTurnBody({
      sessionId: entry.sessionId,
      prompt: renderCoordinatorMessage({
        fromSessionId: context.parentSessionId,
        text: input.message,
      }),
      workspace: entry.workspace,
      roots: entry.roots,
      model: entry.model,
      route: entry.route,
      effort: entry.effort,
      approvePaid: entry.approvePaid,
    });

    const started = this.#headlessTurns().start(body);
    if ("error" in started) {
      entry.turnInFlight = false;
      entry.state = "idle";
      this.#armIdleTimer(entry);
      throw new CommandExecutionError(started.error);
    }

    try {
      await started.recorded;
    } catch (error) {
      entry.turnInFlight = false;
      entry.state = classifyTurnFailure(error, started.ticket.signal.aborted);
      this.#wakeWaiters(entry.parentSessionId);
      if (error instanceof DomainError) {
        throw new CommandExecutionError(error.message);
      }
      throw new CommandExecutionError(
        `failed to send follow-up to "${
          sanitizeBoundaryText(entry.label, 64)
        }": ${summarizeError(error)}`,
      );
    }

    if (this.#parkedApprovals.hasPending(entry.sessionId)) {
      entry.state = "awaiting_approval";
    }
    this.#attachTurnSettlement(entry, started);

    return {
      child: entry.label,
      state: "running",
    };
  }
}
