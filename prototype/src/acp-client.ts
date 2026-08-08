import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type StopReason as AcpStopReason,
} from "@agentclientprotocol/sdk";
import {
  DomainError,
  type ExternalAgentAccessRoute,
  type ExternalAgentCostBasis,
  sanitizeBoundaryText,
} from "./turn-contract";
import { isAbsolute, win32 } from "node:path";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

export type AcpAuthenticationType =
  | "chat-gpt"
  | "api-key"
  | "gateway"
  | "unauthenticated";

export interface AcpRouteEvidence {
  source: "profile_declared" | "agent_auth_status";
  authenticationType?: AcpAuthenticationType;
}

export interface AcpExecutionProfile {
  slug: string;
  command: string;
  args: string[];
  environment: Record<string, string>;
  workspace: string;
  transport: "local_stdio";
  accessRoute: ExternalAgentAccessRoute;
  costBasis: ExternalAgentCostBasis;
  requiredAuthentication?: "chat-gpt";
  initializeTimeoutMs?: number;
  sessionTimeoutMs?: number;
  promptTimeoutMs?: number;
  cancellationTimeoutMs?: number;
  permissionVerdictTimeoutMs?: number;
  terminationTimeoutMs?: number;
}

export interface AcpPermissionPrompt {
  sessionId: string;
  toolCallId: string;
  toolCall: {
    title: string;
    name?: string;
    kind?: string;
    inputSummary: string;
  };
  options: ReadonlyArray<{
    optionId: string;
    name: string;
    kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  }>;
}

export type AcpPermissionDecision = "approve" | "deny";

export interface AcpPermissionVerdict {
  toolCallId: string;
  decision: AcpPermissionDecision | "cancel";
  source: "operator" | "policy";
}

export interface AcpRunInput {
  profile: AcpExecutionProfile;
  prompt: string;
  abortSignal?: AbortSignal;
  onTextDelta?: (text: string) => void;
  /** Must settle after `signal` aborts; the callback owns any resources it starts. */
  confirmPermission?: (
    prompt: AcpPermissionPrompt,
    signal: AbortSignal,
  ) => Promise<AcpPermissionDecision>;
  onPermissionVerdict?: (
    verdict: AcpPermissionVerdict,
    signal: AbortSignal,
  ) => void | Promise<void>;
  onRouteVerified?: (
    evidence: AcpRouteEvidence,
    signal: AbortSignal,
  ) => void | Promise<void>;
}

export interface AcpRunResult {
  text: string;
  stopReason: "stop" | "length" | "error" | "aborted";
  acpStopReason?: AcpStopReason;
  protocolVersion?: number;
  externalSessionId?: string;
  agentName?: string;
  agentVersion?: string;
  capabilities: string[];
  routeEvidence?: AcpRouteEvidence;
  elapsedMs: number;
}

export class AcpRunnerError extends Error {
  constructor(
    message: string,
    public readonly phase:
      | "spawn"
      | "initialize"
      | "authenticate"
      | "session"
      | "prompt"
      | "cancel"
      | "permission"
      | "protocol"
      | "terminate",
  ) {
    super(message);
    this.name = "AcpRunnerError";
  }
}

export class AcpAuthenticationRequiredError extends DomainError {
  readonly phase = "authenticate" as const;
  constructor() {
    super("Codex ChatGPT authentication is required");
    this.name = "AcpAuthenticationRequiredError";
  }
}

export class AcpAccessRouteMismatchError extends DomainError {
  readonly phase = "authenticate" as const;
  constructor() {
    super("Codex ACP is not using ChatGPT authentication");
    this.name = "AcpAccessRouteMismatchError";
  }
}

export class AcpAuthenticationEvidenceError extends DomainError {
  readonly phase = "authenticate" as const;
  constructor() {
    super("Codex ACP authentication evidence is unavailable");
    this.name = "AcpAuthenticationEvidenceError";
  }
}

const DEFAULT_INITIALIZE_TIMEOUT_MS = 5_000;
const DEFAULT_SESSION_TIMEOUT_MS = 5_000;
const DEFAULT_PROMPT_TIMEOUT_MS = 30_000;
const DEFAULT_CANCELLATION_TIMEOUT_MS = 2_000;
const DEFAULT_PERMISSION_VERDICT_TIMEOUT_MS = 2_000;
const DEFAULT_TERMINATION_TIMEOUT_MS = 2_000;
const MAX_PROTOCOL_LINE_BYTES = 393_216;
const MAX_PROTOCOL_INPUT_BYTES = 16_777_216;
const MAX_CHILD_STDERR_BYTES = 1_048_576;
const MAX_PROMPT_BYTES = 60_000;
const MAX_AGENT_RESPONSE_BYTES = 60_000;
const MAX_SESSION_UPDATES = 1_024;
const MAX_PERMISSION_REQUESTS = 128;
const MAX_PERMISSION_OPTIONS = 16;
const MAX_PERMISSION_LABEL_BYTES = 128;
const MAX_PERMISSION_TITLE_BYTES = 256;
const MAX_PERMISSION_INPUT_BYTES = 2_048;
const MAX_CAPABILITIES = 128;
const MAX_CAPABILITY_BYTES = 256;
const MAX_CAPABILITY_DEPTH = 16;
const MAX_CAPABILITY_NODES = 1_024;
const MAX_EXTERNAL_SESSION_ID_BYTES = 256;
const MAX_AGENT_NAME_BYTES = 128;
const MAX_AGENT_VERSION_BYTES = 64;

export class ActivePromptDeadline {
  #remainingMs: number;
  #activeSince: number | undefined;

  constructor(
    timeoutMs: number,
    private readonly now: () => number = performance.now.bind(performance),
  ) {
    this.#remainingMs = timeoutMs;
    this.#activeSince = this.now();
  }

  get isPaused(): boolean {
    return this.#activeSince === undefined;
  }

  get remainingMs(): number {
    if (this.#activeSince === undefined) return this.#remainingMs;
    return Math.max(0, this.#remainingMs - (this.now() - this.#activeSince));
  }

  pause(): void {
    if (this.#activeSince === undefined) return;
    const remainingMs = this.remainingMs;
    if (remainingMs <= 0) return;
    this.#remainingMs = remainingMs;
    this.#activeSince = undefined;
  }

  resume(): void {
    if (this.#activeSince !== undefined) return;
    this.#activeSince = this.now();
  }
}

class AcpAbortRequested extends Error {}

interface ManagedAcpChild {
  pid: number;
  stdin: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
  stderr: Readable;
  status: Promise<void>;
  hasExited: () => boolean;
  signalGroup: (
    signal: NodeJS.Signals | 0,
    timeoutMs: number,
  ) => Promise<boolean>;
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function runSignalCommand(
  args: string[],
  timeoutMs: number,
  command = "/bin/kill",
): Promise<boolean> {
  const signaler = new Deno.Command(command, {
    args,
    stdout: "null",
    stderr: "piped",
    env: { LC_ALL: "C" },
  }).spawn();
  const diagnostic = collectBoundedReadable(signaler.stderr, 256);
  const result = Promise.all([signaler.status, diagnostic.done]);
  void result.catch(() => {});
  try {
    const [status, detail] = await withTimeout(
      result,
      timeoutMs,
      "terminate",
    );
    if (status.success) return true;
    if (detail.includes("No such process")) return false;
    const summary = detail.trim().slice(0, 256);
    throw new AcpRunnerError(
      summary === ""
        ? "ACP process-group signaling failed"
        : `ACP process-group signaling failed (${summary})`,
      "terminate",
    );
  } catch (error) {
    try {
      signaler.kill("SIGKILL");
    } catch {
      // The signal command may have exited at the timeout boundary.
    }
    await withTimeout(
      diagnostic.cancel(),
      timeoutMs,
      "terminate",
    ).catch(() => {});
    throw error;
  }
}

function collectBoundedReadable(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): { done: Promise<string>; cancel: () => Promise<void> } {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let cancelled = false;
  const cancel = async () => {
    if (cancelled) return;
    cancelled = true;
    await reader.cancel().catch(() => {});
  };
  const done = (async () => {
    try {
      while (bytes < maxBytes) {
        const result = await reader.read();
        if (result.done) break;
        const remaining = maxBytes - bytes;
        const chunk = result.value.subarray(0, remaining);
        chunks.push(chunk);
        bytes += chunk.byteLength;
        if (result.value.byteLength > remaining || bytes === maxBytes) {
          await cancel();
        }
      }
    } finally {
      reader.releaseLock();
    }
    const collected = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      collected.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(collected);
  })();
  return { done, cancel };
}

async function spawnAcpChild(
  profile: AcpExecutionProfile,
): Promise<ManagedAcpChild> {
  const useProcessGroup = Deno.build.os !== "windows";
  if (!useProcessGroup && profile.slug === "codex-chatgpt") {
    throw new AcpRunnerError(
      "ACP process-group containment is unavailable on this platform",
      "spawn",
    );
  }
  if (useProcessGroup) {
    await assertProcessGroupSignaler(
      "/bin/kill",
      profile.terminationTimeoutMs ?? DEFAULT_TERMINATION_TIMEOUT_MS,
    );
  }
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(profile.command, [...profile.args], {
      cwd: profile.workspace,
      detached: useProcessGroup,
      env: { ...profile.environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    throw new AcpRunnerError("ACP child could not be started", "spawn");
  }
  let exited = false;
  const status = new Promise<void>((resolve, reject) => {
    child.once("exit", () => {
      exited = true;
      resolve();
    });
    child.once("error", () => {
      exited = true;
      reject(
        new AcpRunnerError("ACP child could not be started", "spawn"),
      );
    });
  });
  void status.catch(() => {});
  if (child.pid === undefined) {
    child.kill("SIGKILL");
    throw new AcpRunnerError("ACP child could not be started", "spawn");
  }
  const pid = child.pid;
  let groupMayExist = true;
  return {
    pid,
    stdin: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    stderr: child.stderr,
    status,
    hasExited: () => exited,
    signalGroup: async (signal, timeoutMs) => {
      if (!groupMayExist) return false;
      if (!useProcessGroup) {
        try {
          const success = child.kill(signal);
          if (signal === 0 && !success) groupMayExist = false;
          return success;
        } catch {
          if (exited) {
            groupMayExist = false;
            return false;
          }
          throw new AcpRunnerError("ACP child signaling failed", "terminate");
        }
      }
      const signalName = signal === 0 ? "0" : signal.replace("SIG", "");
      let success: boolean;
      try {
        success = await runSignalCommand(
          [`-${signalName}`, "--", `-${pid}`],
          timeoutMs,
        );
      } catch (error) {
        // macOS can briefly report EPERM after the group leader exits but
        // before its exit event is reaped. Re-probe only after that direct
        // child settles; a live or inaccessible descendant still surfaces.
        if (
          !(await settlesWithin(status, Math.min(timeoutMs, 100))) ||
          await runSignalCommand(["-0", "--", `-${pid}`], timeoutMs)
        ) {
          throw error;
        }
        groupMayExist = false;
        return false;
      }
      if (signal === 0 && !success) groupMayExist = false;
      return success;
    },
  };
}

export async function assertProcessGroupSignaler(
  command = "/bin/kill",
  timeoutMs = DEFAULT_TERMINATION_TIMEOUT_MS,
): Promise<void> {
  const probe = spawn(Deno.execPath(), [
    "eval",
    "setInterval(() => {}, 60_000)",
  ], {
    detached: true,
    env: {},
    stdio: ["ignore", "ignore", "ignore"],
  });
  const probeStatus = new Promise<void>((resolve) => {
    probe.once("exit", () => resolve());
    probe.once("error", () => resolve());
  });
  try {
    if (probe.pid === undefined) throw new Error("signal probe failed");
    if (
      !(await runSignalCommand(
        ["-0", "--", `-${probe.pid}`],
        timeoutMs,
        command,
      ))
    ) {
      throw new Error("signal probe failed");
    }
  } catch {
    throw new AcpRunnerError(
      "ACP process-group signaling is unavailable on this platform",
      "spawn",
    );
  } finally {
    try {
      probe.kill("SIGKILL");
    } catch {
      // The inert probe exited while its capability check was running.
    }
    if (!(await settlesWithin(probeStatus, timeoutMs))) {
      throw new AcpRunnerError(
        "ACP process-group signaling is unavailable on this platform",
        "spawn",
      );
    }
  }
}

async function waitForProcessGroupExit(
  child: ManagedAcpChild,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (
      !(await child.signalGroup(
        0,
        Math.max(1, deadline - performance.now()),
      ))
    ) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

function addUtf8BytesWithinLimit(
  value: string,
  currentBytes: number,
  maxBytes: number,
): number {
  const encoder = new TextEncoder();
  const buffer = new Uint8Array(12_288);
  let bytes = currentBytes;
  for (let start = 0; start < value.length;) {
    let end = Math.min(start + 4_096, value.length);
    if (
      end < value.length &&
      value.charCodeAt(end - 1) >= 0xD800 &&
      value.charCodeAt(end - 1) <= 0xDBFF &&
      value.charCodeAt(end) >= 0xDC00 &&
      value.charCodeAt(end) <= 0xDFFF
    ) {
      end -= 1;
    }
    const { written } = encoder.encodeInto(value.slice(start, end), buffer);
    bytes += written;
    if (bytes > maxBytes) {
      throw new AcpRunnerError(
        "ACP agent response exceeded the text limit",
        "protocol",
      );
    }
    start = end;
  }
  return bytes;
}

function assertProfile(profile: AcpExecutionProfile): void {
  if (!profile.slug.trim()) {
    throw new AcpRunnerError("ACP profile has no slug", "spawn");
  }
  if (
    !isAbsolute(profile.command) &&
    !(Deno.build.os === "windows" && win32.isAbsolute(profile.command))
  ) {
    throw new AcpRunnerError("ACP profile command must be absolute", "spawn");
  }
  if (
    !isAbsolute(profile.workspace) &&
    !(Deno.build.os === "windows" && win32.isAbsolute(profile.workspace))
  ) {
    throw new AcpRunnerError("ACP workspace must be absolute", "session");
  }
  for (const key of Object.keys(profile.environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new AcpRunnerError(
        "ACP profile contains an invalid environment name",
        "spawn",
      );
    }
  }
}

export function assertAcpPromptWithinLimit(prompt: string): void {
  try {
    addUtf8BytesWithinLimit(prompt, 0, MAX_PROMPT_BYTES);
  } catch (error) {
    if (error instanceof AcpRunnerError) {
      throw new AcpRunnerError("ACP prompt exceeded the input limit", "prompt");
    }
    throw error;
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  phase: AcpRunnerError["phase"],
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new AcpRunnerError(`ACP ${phase} timed out`, phase)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function drainStream(
  stream: Readable,
  maxBytes = Number.POSITIVE_INFINITY,
): {
  done: Promise<void>;
  cancel: () => Promise<void>;
} {
  let bytes = 0;
  let settled = false;
  let resolveDone!: () => void;
  const suppressLateError = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const finish = () => {
    if (settled) return;
    settled = true;
    stream.off("data", onData);
    stream.off("end", finish);
    stream.off("close", finish);
    stream.off("error", finish);
    stream.on("error", suppressLateError);
    resolveDone();
  };
  const onData = (chunk: Uint8Array | string) => {
    bytes += typeof chunk === "string"
      ? new TextEncoder().encode(chunk).byteLength
      : chunk.byteLength;
    if (bytes > maxBytes) {
      stream.destroy();
      finish();
    }
  };
  stream.on("data", onData);
  stream.once("end", finish);
  stream.once("close", finish);
  stream.once("error", finish);
  return {
    done,
    cancel: async () => {
      stream.destroy();
      finish();
    },
  };
}

export async function settleDrain(
  drain: ReturnType<typeof drainStream>,
  timeoutMs: number,
): Promise<void> {
  try {
    await withTimeout(drain.done, timeoutMs, "terminate");
  } catch {
    void drain.cancel();
    await withTimeout(drain.done, timeoutMs, "terminate").catch(() => {});
  }
}

export function guardedProtocolInput(
  input: ReadableStream<Uint8Array>,
  activeSessionId: () => string | undefined,
  onProtocolError: (error: AcpRunnerError) => void,
): ReadableStream<Uint8Array> {
  let pending = new Uint8Array();
  let pendingLength = 0;
  let protocolInputBytes = 0;
  let sessionUpdateCount = 0;
  let agentResponseBytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });

  const reject = (message: string): never => {
    const error = new AcpRunnerError(message, "protocol");
    onProtocolError(error);
    throw error;
  };
  const validateLine = (line: Uint8Array): void => {
    const content = line.at(-1) === 13 ? line.slice(0, -1) : line;
    let message: unknown;
    try {
      message = JSON.parse(decoder.decode(content));
    } catch {
      reject("ACP agent sent malformed protocol data");
    }
    if (
      typeof message !== "object" || message === null || Array.isArray(message)
    ) {
      reject("ACP agent sent malformed protocol data");
    }
    const record = message as Record<string, unknown>;
    if (record.method !== methods.client.session.update) return;
    sessionUpdateCount += 1;
    if (sessionUpdateCount > MAX_SESSION_UPDATES) {
      reject("ACP agent exceeded the session-update limit");
    }
    const params = record.params;
    if (
      typeof params !== "object" || params === null || Array.isArray(params)
    ) {
      reject("ACP agent sent malformed session data");
    }
    const receivedSessionId = (params as Record<string, unknown>).sessionId;
    const expectedSessionId = activeSessionId();
    if (typeof receivedSessionId !== "string") {
      reject("ACP agent sent malformed session data");
    }
    if (expectedSessionId === undefined) {
      reject("ACP agent sent session data before session creation");
    }
    if (receivedSessionId !== expectedSessionId) {
      reject("ACP agent sent a cross-session update");
    }
    const update = (params as Record<string, unknown>).update;
    if (
      typeof update !== "object" || update === null || Array.isArray(update)
    ) {
      reject("ACP agent sent malformed session data");
    }
    const updateRecord = update as Record<string, unknown>;
    const responseContent = updateRecord.content;
    if (
      updateRecord.sessionUpdate === "agent_message_chunk" &&
      typeof responseContent === "object" && responseContent !== null &&
      !Array.isArray(responseContent)
    ) {
      const contentRecord = responseContent as Record<string, unknown>;
      if (
        contentRecord.type === "text" &&
        typeof contentRecord.text === "string"
      ) {
        try {
          agentResponseBytes = addUtf8BytesWithinLimit(
            contentRecord.text,
            agentResponseBytes,
            MAX_AGENT_RESPONSE_BYTES,
          );
        } catch (error) {
          if (error instanceof AcpRunnerError) onProtocolError(error);
          throw error;
        }
      }
    }
  };

  return input.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        protocolInputBytes += chunk.byteLength;
        if (protocolInputBytes > MAX_PROTOCOL_INPUT_BYTES) {
          reject("ACP agent exceeded the protocol-input limit");
        }
        const append = (part: Uint8Array) => {
          const required = pendingLength + part.length;
          if (required > MAX_PROTOCOL_LINE_BYTES) {
            reject("ACP agent sent an oversized protocol message");
          }
          if (required > pending.length) {
            let capacity = Math.max(8_192, pending.length * 2);
            while (capacity < required) capacity *= 2;
            const grown = new Uint8Array(
              Math.min(capacity, MAX_PROTOCOL_LINE_BYTES),
            );
            grown.set(pending.subarray(0, pendingLength));
            pending = grown;
          }
          pending.set(part, pendingLength);
          pendingLength = required;
        };
        let start = 0;
        for (let index = 0; index < chunk.length; index++) {
          if (chunk[index] !== 10) continue;
          append(chunk.subarray(start, index));
          const line = pending.subarray(0, pendingLength);
          validateLine(line);
          const framed = new Uint8Array(pendingLength + 1);
          framed.set(line);
          framed[pendingLength] = 10;
          controller.enqueue(framed);
          pendingLength = 0;
          start = index + 1;
        }
        append(chunk.subarray(start));
      },
      flush(controller) {
        if (pendingLength === 0) return;
        const line = pending.slice(0, pendingLength);
        validateLine(line);
        controller.enqueue(line);
      },
    }),
  );
}

function capabilityNames(
  value: unknown,
): string[] {
  const names: string[] = [];
  const pending: Array<{ value: unknown; prefix: string; depth: number }> = [{
    value,
    prefix: "",
    depth: 0,
  }];
  let visited = 0;
  while (
    pending.length > 0 && names.length < MAX_CAPABILITIES &&
    visited < MAX_CAPABILITY_NODES
  ) {
    const current = pending.pop()!;
    visited += 1;
    if (
      current.value === null || typeof current.value !== "object" ||
      Array.isArray(current.value) || current.depth >= MAX_CAPABILITY_DEPTH
    ) {
      continue;
    }
    const record = current.value as Record<string, unknown>;
    for (const key in record) {
      if (!Object.hasOwn(record, key)) continue;
      if (visited >= MAX_CAPABILITY_NODES) break;
      visited += 1;
      const child = record[key];
      if (key === "_meta") continue;
      const path = sanitizeBoundaryText(
        current.prefix ? `${current.prefix}.${key}` : key,
        MAX_CAPABILITY_BYTES,
      );
      if (
        child === true ||
        (current.prefix && isEmptyRecord(child))
      ) {
        names.push(path);
        if (names.length >= MAX_CAPABILITIES) break;
      } else {
        pending.push({
          value: child,
          prefix: path,
          depth: current.depth + 1,
        });
      }
    }
  }
  return names.sort();
}

function isEmptyRecord(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  for (const key in value) {
    if (Object.hasOwn(value, key)) return false;
  }
  return true;
}

function textFromUpdate(update: Record<string, unknown>): string | null {
  if (update.sessionUpdate !== "agent_message_chunk") return null;
  const content = update.content;
  if (typeof content !== "object" || content === null) return null;
  const block = content as Record<string, unknown>;
  return block.type === "text" && typeof block.text === "string"
    ? block.text
    : null;
}

function permissionInputSummary(value: unknown): string {
  if (value === undefined) return "(not supplied)";
  try {
    return sanitizeBoundaryText(
      JSON.stringify(value),
      MAX_PERMISSION_INPUT_BYTES,
    );
  } catch {
    return "(unavailable)";
  }
}

function selectPermissionOption(
  options: RequestPermissionRequest["options"],
  decision: AcpPermissionDecision,
): string | null {
  const wanted = decision === "approve" ? "allow_once" : "reject_once";
  return options.find((option) => option.kind === wanted)?.optionId ??
    null;
}

function normalizeStopReason(
  stopReason: AcpStopReason,
): AcpRunResult["stopReason"] {
  switch (stopReason) {
    case "end_turn":
      return "stop";
    case "max_tokens":
    case "max_turn_requests":
      return "length";
    case "cancelled":
      return "aborted";
    case "refusal":
      return "error";
  }
}

async function terminateChild(
  child: ManagedAcpChild,
  timeoutMs: number,
): Promise<void> {
  if (child.hasExited()) {
    if (!(await child.signalGroup(0, timeoutMs))) {
      await withTimeout(child.status, timeoutMs, "terminate");
      return;
    }
  }
  let groupExited = false;
  try {
    await child.signalGroup("SIGTERM", timeoutMs);
    groupExited = await waitForProcessGroupExit(child, timeoutMs);
  } catch {
    // A failed or timed-out graceful signal still requires hard-stop cleanup.
  }
  if (!groupExited) {
    await child.signalGroup("SIGKILL", timeoutMs);
    if (!(await waitForProcessGroupExit(child, timeoutMs))) {
      throw new AcpRunnerError(
        "ACP process group could not be terminated",
        "terminate",
      );
    }
  }
  await withTimeout(child.status, timeoutMs, "terminate");
}

export async function runAcpAgent(input: AcpRunInput): Promise<AcpRunResult> {
  assertProfile(input.profile);
  assertAcpPromptWithinLimit(input.prompt);
  const startedAt = Date.now();
  const profile = input.profile;
  const abortedResult = (evidence: {
    protocolVersion?: number;
    externalSessionId?: string;
    agentName?: string;
    agentVersion?: string;
    capabilities?: string[];
    routeEvidence?: AcpRouteEvidence;
  } = {}): AcpRunResult => {
    const { routeEvidence, ...verifiedEvidence } = evidence;
    return {
      text: "",
      stopReason: "aborted",
      ...verifiedEvidence,
      capabilities: evidence.capabilities ?? [],
      ...(routeEvidence === undefined ? {} : { routeEvidence }),
      elapsedMs: Date.now() - startedAt,
    };
  };
  if (input.abortSignal?.aborted) return abortedResult();
  const child = await spawnAcpChild(profile);
  const stderr = drainStream(child.stderr, MAX_CHILD_STDERR_BYTES);
  let activeSessionId: string | undefined;
  let cancelRequested = false;
  let cancelDeadline: number | undefined;
  let cancelPromise: Promise<void> | undefined;
  let protocolError: AcpRunnerError | undefined;
  let routeVerificationError: unknown;
  let primaryFailure: unknown;
  let permissionCount = 0;
  const protocolErrorRaised = Promise.withResolvers<void>();
  const permissionWindowClosed = Promise.withResolvers<void>();
  const permissionWindowController = new AbortController();
  let permissionsClosed = false;
  const pendingPermissionVerdicts = new Set<Promise<void>>();
  let activePermissionRequests = 0;
  let permissionRequestsSettled = Promise.withResolvers<void>();
  permissionRequestsSettled.resolve();
  let pendingPermissionConfirmations = 0;
  let permissionConfirmationsSettled = Promise.withResolvers<void>();
  permissionConfirmationsSettled.resolve();
  let promptDeadline: ActivePromptDeadline | undefined;
  let promptDeadlineChanged = Promise.withResolvers<void>();
  const notifyPromptDeadlineChanged = () => {
    promptDeadlineChanged.resolve();
    promptDeadlineChanged = Promise.withResolvers<void>();
  };
  const beginPermissionConfirmation = () => {
    if (pendingPermissionConfirmations === 0) {
      permissionConfirmationsSettled = Promise.withResolvers<void>();
      promptDeadline?.pause();
      notifyPromptDeadlineChanged();
    }
    pendingPermissionConfirmations += 1;
  };
  const endPermissionConfirmation = () => {
    pendingPermissionConfirmations -= 1;
    if (pendingPermissionConfirmations === 0) {
      promptDeadline?.resume();
      permissionConfirmationsSettled.resolve();
      notifyPromptDeadlineChanged();
    }
  };
  const closePermissionWindow = () => {
    if (permissionsClosed) return;
    permissionsClosed = true;
    permissionWindowController.abort();
    permissionWindowClosed.resolve();
  };
  const waitForPendingPermissionWork = async (): Promise<void> => {
    while (activePermissionRequests > 0) {
      await permissionRequestsSettled.promise;
    }
    while (pendingPermissionConfirmations > 0) {
      await permissionConfirmationsSettled.promise;
    }
    await Promise.all([...pendingPermissionVerdicts]);
    if (protocolError !== undefined) throw protocolError;
  };
  const trackPermissionRequest = async <T>(
    operation: () => Promise<T>,
  ): Promise<T> => {
    if (activePermissionRequests === 0) {
      permissionRequestsSettled = Promise.withResolvers<void>();
    }
    activePermissionRequests += 1;
    try {
      return await operation();
    } catch (error) {
      const contained = error instanceof AcpRunnerError
        ? error
        : new AcpRunnerError(
          "ACP permission exchange could not be completed",
          "permission",
        );
      noteProtocolError(contained);
      throw contained;
    } finally {
      activePermissionRequests -= 1;
      if (activePermissionRequests === 0) permissionRequestsSettled.resolve();
    }
  };
  const noteProtocolError = (error: AcpRunnerError): void => {
    protocolError ??= error;
    protocolErrorRaised.resolve();
  };
  const recordPermissionVerdict = (
    verdict: AcpPermissionVerdict,
  ): Promise<void> => {
    if (input.onPermissionVerdict === undefined) return Promise.resolve();
    const operation = (async () => {
      const controller = new AbortController();
      const forwardAbort = () => controller.abort();
      if (verdict.decision !== "cancel") {
        input.abortSignal?.addEventListener("abort", forwardAbort, {
          once: true,
        });
        permissionWindowController.signal.addEventListener(
          "abort",
          forwardAbort,
          { once: true },
        );
        if (input.abortSignal?.aborted) controller.abort();
        if (permissionWindowController.signal.aborted) controller.abort();
      }
      try {
        await withTimeout(
          Promise.resolve(
            input.onPermissionVerdict!(verdict, controller.signal),
          ),
          profile.permissionVerdictTimeoutMs ??
            DEFAULT_PERMISSION_VERDICT_TIMEOUT_MS,
          "permission",
        );
      } finally {
        controller.abort();
        input.abortSignal?.removeEventListener("abort", forwardAbort);
        permissionWindowController.signal.removeEventListener(
          "abort",
          forwardAbort,
        );
      }
    })();
    const settled = operation.then(
      () => undefined,
      () => undefined,
    );
    pendingPermissionVerdicts.add(settled);
    void settled.finally(() => pendingPermissionVerdicts.delete(settled));
    return operation;
  };
  let protocolVersion: number | undefined;
  let externalSessionId: string | undefined;
  let agentName: string | undefined;
  let agentVersion: string | undefined;
  let capabilities: string[] = [];
  let routeEvidence: AcpRouteEvidence | undefined;
  const lifecycleAbort = Promise.withResolvers<void>();
  const noteLifecycleAbort = () => {
    closePermissionWindow();
    lifecycleAbort.resolve();
  };
  const abortableLifecycle = <T>(promise: Promise<T>): Promise<T> =>
    Promise.race([
      promise,
      lifecycleAbort.promise.then(() => {
        throw new AcpAbortRequested();
      }),
    ]);
  input.abortSignal?.addEventListener("abort", noteLifecycleAbort, {
    once: true,
  });
  if (input.abortSignal?.aborted) noteLifecycleAbort();

  const app = client({ name: "dyfj-workbench" })
    .onNotification(methods.client.session.update, ({ params }) => {
      if (
        activeSessionId !== undefined && params.sessionId !== activeSessionId
      ) {
        noteProtocolError(
          new AcpRunnerError(
            "ACP agent sent a cross-session update",
            "protocol",
          ),
        );
      }
    })
    .onRequest(
      methods.client.session.requestPermission,
      ({ params }) =>
        trackPermissionRequest(async () => {
          if (permissionsClosed) {
            return { outcome: { outcome: "cancelled" } };
          }
          if (params.sessionId !== activeSessionId) {
            noteProtocolError(
              new AcpRunnerError(
                "ACP agent sent a cross-session permission request",
                "protocol",
              ),
            );
            return { outcome: { outcome: "cancelled" } };
          }
          permissionCount += 1;
          if (permissionCount > MAX_PERMISSION_REQUESTS) {
            noteProtocolError(
              new AcpRunnerError(
                "ACP agent exceeded the permission-request limit",
                "protocol",
              ),
            );
            return { outcome: { outcome: "cancelled" } };
          }
          const optionIds = new Set<string>();
          for (const option of params.options) {
            if (optionIds.has(option.optionId)) {
              noteProtocolError(
                new AcpRunnerError(
                  "ACP agent sent duplicate permission option identifiers",
                  "protocol",
                ),
              );
              return { outcome: { outcome: "cancelled" } };
            }
            optionIds.add(option.optionId);
          }
          const permissionRef = `acp-permission-${permissionCount}`;
          const offeredOptions = params.options.slice(
            0,
            MAX_PERMISSION_OPTIONS,
          );
          if (cancelRequested) {
            await recordPermissionVerdict({
              toolCallId: permissionRef,
              decision: "cancel",
              source: "policy",
            });
            return { outcome: { outcome: "cancelled" } };
          }
          const source = input.confirmPermission === undefined
            ? "policy" as const
            : "operator" as const;
          const prompt = {
            sessionId: params.sessionId,
            toolCallId: permissionRef,
            toolCall: {
              title: sanitizeBoundaryText(
                params.toolCall.title ?? "External agent action",
                MAX_PERMISSION_TITLE_BYTES,
              ),
              name: params.toolCall.name === null ||
                  params.toolCall.name === undefined
                ? undefined
                : sanitizeBoundaryText(
                  params.toolCall.name,
                  MAX_PERMISSION_LABEL_BYTES,
                ),
              kind: params.toolCall.kind ?? undefined,
              inputSummary: permissionInputSummary(params.toolCall.rawInput),
            },
            options: offeredOptions.map(({ optionId, name, kind }) => ({
              optionId,
              name: sanitizeBoundaryText(name, MAX_PERMISSION_LABEL_BYTES),
              kind,
            })),
          };
          let decisionOutcome:
            | { kind: "decision"; decision: AcpPermissionDecision }
            | { kind: "closed" };
          if (input.confirmPermission === undefined) {
            decisionOutcome = { kind: "decision", decision: "deny" };
          } else {
            const confirmationController = new AbortController();
            beginPermissionConfirmation();
            try {
              decisionOutcome = await Promise.race([
                Promise.resolve(
                  input.confirmPermission(
                    prompt,
                    confirmationController.signal,
                  ),
                ).then(
                  (decision) => ({ kind: "decision" as const, decision }),
                ),
                permissionWindowClosed.promise.then(() => ({
                  kind: "closed" as const,
                })),
              ]);
            } finally {
              confirmationController.abort();
              endPermissionConfirmation();
            }
          }
          if (decisionOutcome.kind === "closed") {
            await recordPermissionVerdict({
              toolCallId: permissionRef,
              decision: "cancel",
              source: "policy",
            });
            return { outcome: { outcome: "cancelled" } };
          }
          const decision = decisionOutcome.decision;
          if (cancelRequested) {
            await recordPermissionVerdict({
              toolCallId: permissionRef,
              decision: "cancel",
              source: "policy",
            });
            return { outcome: { outcome: "cancelled" } };
          }
          const selectedOptionId = selectPermissionOption(
            decision === "deny" ? params.options : offeredOptions,
            decision,
          );
          const optionId = selectedOptionId ??
            (decision === "approve"
              ? selectPermissionOption(params.options, "deny")
              : null);
          const recordedDecision = optionId === null
            ? "cancel"
            : selectedOptionId === null
            ? "deny"
            : decision;
          try {
            await recordPermissionVerdict({
              toolCallId: permissionRef,
              decision: recordedDecision,
              source: optionId === null || selectedOptionId === null
                ? "policy"
                : source,
            });
          } catch (error) {
            if (!cancelRequested && !permissionsClosed) throw error;
            await recordPermissionVerdict({
              toolCallId: permissionRef,
              decision: "cancel",
              source: "policy",
            });
            return { outcome: { outcome: "cancelled" } };
          }
          if (cancelRequested || permissionsClosed) {
            await recordPermissionVerdict({
              toolCallId: permissionRef,
              decision: "cancel",
              source: "policy",
            });
            return { outcome: { outcome: "cancelled" } };
          }
          return optionId === null
            ? { outcome: { outcome: "cancelled" } }
            : { outcome: { outcome: "selected", optionId } };
        }),
    );

  try {
    return await app.connectWith(
      ndJsonStream(
        child.stdin,
        guardedProtocolInput(
          child.stdout,
          () => activeSessionId,
          noteProtocolError,
        ),
      ),
      async (context) => {
        const initialized = await withTimeout(
          abortableLifecycle(context.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {},
            clientInfo: { name: "dyfj-workbench", version: "0.1.0" },
          })),
          profile.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS,
          "initialize",
        );
        if (initialized.protocolVersion !== PROTOCOL_VERSION) {
          throw new AcpRunnerError(
            "ACP agent negotiated an unsupported protocol version",
            "initialize",
          );
        }
        protocolVersion = initialized.protocolVersion;
        capabilities = capabilityNames(initialized.agentCapabilities);
        agentName = initialized.agentInfo?.name === undefined
          ? undefined
          : sanitizeBoundaryText(
            initialized.agentInfo.name,
            MAX_AGENT_NAME_BYTES,
          );
        agentVersion = initialized.agentInfo?.version === undefined
          ? undefined
          : sanitizeBoundaryText(
            initialized.agentInfo.version,
            MAX_AGENT_VERSION_BYTES,
          );
        let pendingRouteEvidence: AcpRouteEvidence;
        if (profile.requiredAuthentication === "chat-gpt") {
          let authenticationStatus: unknown;
          try {
            authenticationStatus = await withTimeout(
              abortableLifecycle(
                (context as unknown as {
                  request: (
                    method: string,
                    params: Record<string, never>,
                  ) => Promise<unknown>;
                }).request("authentication/status", {}),
              ),
              profile.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS,
              "authenticate",
            );
          } catch (error) {
            if (error instanceof AcpAbortRequested) throw error;
            throw new AcpAuthenticationEvidenceError();
          }
          if (
            typeof authenticationStatus !== "object" ||
            authenticationStatus === null ||
            Array.isArray(authenticationStatus) ||
            typeof (authenticationStatus as { type?: unknown }).type !==
              "string"
          ) {
            throw new AcpAuthenticationEvidenceError();
          }
          const authenticationType = (authenticationStatus as {
            type: string;
          }).type;
          if (authenticationType === "unauthenticated") {
            throw new AcpAuthenticationRequiredError();
          }
          if (
            authenticationType === "api-key" ||
            authenticationType === "gateway"
          ) {
            throw new AcpAccessRouteMismatchError();
          }
          if (authenticationType !== "chat-gpt") {
            throw new AcpAuthenticationEvidenceError();
          }
          pendingRouteEvidence = {
            source: "profile_declared",
            authenticationType: "chat-gpt",
          };
        } else {
          pendingRouteEvidence = { source: "profile_declared" };
        }
        const routeVerificationController = new AbortController();
        const forwardRouteAbort = () => routeVerificationController.abort();
        input.abortSignal?.addEventListener("abort", forwardRouteAbort, {
          once: true,
        });
        if (input.abortSignal?.aborted) routeVerificationController.abort();
        try {
          await withTimeout(
            Promise.resolve(
              input.onRouteVerified?.(
                pendingRouteEvidence,
                routeVerificationController.signal,
              ),
            ),
            profile.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS,
            "authenticate",
          );
          routeEvidence = pendingRouteEvidence;
        } catch (error) {
          if (input.abortSignal?.aborted) throw new AcpAbortRequested();
          routeVerificationError = error;
          throw error;
        } finally {
          routeVerificationController.abort();
          input.abortSignal?.removeEventListener(
            "abort",
            forwardRouteAbort,
          );
        }
        const session = await withTimeout(
          abortableLifecycle(context.buildSession(profile.workspace).start()),
          profile.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS,
          "session",
        );
        try {
          activeSessionId = session.sessionId;
          externalSessionId = sanitizeBoundaryText(
            session.sessionId,
            MAX_EXTERNAL_SESSION_ID_BYTES,
          );
          const closeSession = async () => {
            if (!initialized.agentCapabilities?.sessionCapabilities?.close) {
              return;
            }
            await withTimeout(
              context.request(methods.agent.session.close, {
                sessionId: session.sessionId,
              }),
              profile.terminationTimeoutMs ??
                DEFAULT_TERMINATION_TIMEOUT_MS,
              "terminate",
            );
          };
          const resultEvidence = {
            protocolVersion,
            externalSessionId,
            agentName,
            agentVersion,
            capabilities,
            routeEvidence,
          };
          if (input.abortSignal?.aborted) {
            await closeSession();
            return {
              text: "",
              stopReason: "aborted" as const,
              ...resultEvidence,
              elapsedMs: Date.now() - startedAt,
            };
          }
          const requestCancel = () => {
            if (cancelRequested) return;
            cancelRequested = true;
            cancelDeadline = Date.now() +
              (profile.cancellationTimeoutMs ??
                DEFAULT_CANCELLATION_TIMEOUT_MS);
            cancelPromise = context.notify(methods.agent.session.cancel, {
              sessionId: session.sessionId,
            });
          };
          const abortRequested = Promise.withResolvers<void>();
          const requestCancelAndWake = () => {
            closePermissionWindow();
            requestCancel();
            abortRequested.resolve();
          };
          input.abortSignal?.addEventListener("abort", requestCancelAndWake, {
            once: true,
          });
          try {
            promptDeadline = new ActivePromptDeadline(
              profile.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS,
            );
            if (pendingPermissionConfirmations > 0) promptDeadline.pause();
            const promptFailed = Promise.withResolvers<void>();
            void session.prompt(input.prompt).catch(() => {
              promptFailed.resolve();
            });
            if (input.abortSignal?.aborted) requestCancelAndWake();
            let text = "";
            let updateCount = 0;
            let pendingUpdate = session.nextUpdate();
            while (true) {
              const next = Promise.race([
                pendingUpdate.then((message) => ({
                  kind: "message" as const,
                  message,
                })),
                protocolErrorRaised.promise.then(() => ({
                  kind: "protocol" as const,
                })),
                promptFailed.promise.then(() => ({
                  kind: "prompt_failure" as const,
                })),
                ...(!cancelRequested
                  ? [promptDeadlineChanged.promise.then(() => ({
                    kind: "prompt_deadline_changed" as const,
                  }))]
                  : []),
                ...(cancelRequested ? [] : [abortRequested.promise.then(() => ({
                  kind: "cancel" as const,
                }))]),
              ]);
              const timeoutMs = cancelRequested
                ? Math.max(1, (cancelDeadline ?? Date.now()) - Date.now())
                : promptDeadline.isPaused
                ? undefined
                : promptDeadline.remainingMs;
              if (timeoutMs !== undefined && timeoutMs <= 0) {
                throw new AcpRunnerError(
                  `ACP ${cancelRequested ? "cancel" : "prompt"} timed out`,
                  cancelRequested ? "cancel" : "prompt",
                );
              }
              const outcome = timeoutMs === undefined
                ? await next
                : await withTimeout(
                  next,
                  timeoutMs,
                  cancelRequested ? "cancel" : "prompt",
                );
              if (outcome.kind === "cancel") continue;
              if (outcome.kind === "prompt_deadline_changed") continue;
              if (outcome.kind === "protocol") {
                throw protocolError ?? new AcpRunnerError(
                  "ACP protocol exchange failed",
                  "protocol",
                );
              }
              if (outcome.kind === "prompt_failure") {
                throw new AcpRunnerError(
                  "ACP prompt request failed before the turn completed",
                  "prompt",
                );
              }
              if (protocolError !== undefined) throw protocolError;
              const message = outcome.message;
              if (message.kind === "session_update") {
                updateCount += 1;
                if (updateCount > MAX_SESSION_UPDATES) {
                  throw new AcpRunnerError(
                    "ACP agent exceeded the session-update limit",
                    "protocol",
                  );
                }
                if (message.notification.sessionId !== session.sessionId) {
                  throw new AcpRunnerError(
                    "ACP agent sent a cross-session update",
                    "protocol",
                  );
                }
                const delta = textFromUpdate(
                  message.update as unknown as Record<string, unknown>,
                );
                if (delta !== null) {
                  text += delta;
                  input.onTextDelta?.(delta);
                }
                pendingUpdate = session.nextUpdate();
                continue;
              }
              const cancellationPrecededTerminal = cancelRequested;
              closePermissionWindow();
              await waitForPendingPermissionWork();
              if (cancellationPrecededTerminal && cancelPromise !== undefined) {
                await withTimeout(
                  cancelPromise,
                  Math.max(1, (cancelDeadline ?? Date.now()) - Date.now()),
                  "cancel",
                );
              }
              const stopReason = normalizeStopReason(message.stopReason);
              if (cancellationPrecededTerminal && stopReason !== "aborted") {
                throw new AcpRunnerError(
                  "ACP cancellation was not acknowledged",
                  "cancel",
                );
              }
              await closeSession();
              return {
                text,
                stopReason,
                acpStopReason: message.stopReason,
                ...resultEvidence,
                elapsedMs: Date.now() - startedAt,
              };
            }
          } finally {
            closePermissionWindow();
            input.abortSignal?.removeEventListener(
              "abort",
              requestCancelAndWake,
            );
          }
        } finally {
          session.dispose();
        }
      },
    );
  } catch (error) {
    if (routeVerificationError !== undefined) {
      primaryFailure = routeVerificationError instanceof Error
        ? routeVerificationError
        : new AcpRunnerError(
          "ACP route verification could not be completed",
          "authenticate",
        );
      throw primaryFailure;
    }
    if (protocolError !== undefined) {
      primaryFailure = protocolError;
      throw protocolError;
    }
    if (error instanceof AcpAbortRequested) {
      return abortedResult({
        protocolVersion,
        externalSessionId,
        agentName,
        agentVersion,
        capabilities,
        routeEvidence,
      });
    }
    if (error instanceof AcpRunnerError || error instanceof DomainError) {
      primaryFailure = error;
      throw error;
    }
    primaryFailure = new AcpRunnerError(
      "ACP prompt exchange ended before a terminal response",
      "prompt",
    );
    throw primaryFailure;
  } finally {
    const terminationTimeoutMs = profile.terminationTimeoutMs ??
      DEFAULT_TERMINATION_TIMEOUT_MS;
    input.abortSignal?.removeEventListener("abort", noteLifecycleAbort);
    try {
      await withTimeout(
        child.stdin.close(),
        terminationTimeoutMs,
        "terminate",
      );
    } catch {
      // The SDK may already have closed the protocol stream.
    }
    let terminationFailure: unknown;
    try {
      await terminateChild(
        child,
        terminationTimeoutMs,
      );
    } catch (error) {
      terminationFailure = error;
    } finally {
      await settleDrain(stderr, terminationTimeoutMs);
    }
    if (terminationFailure !== undefined) {
      if (primaryFailure === undefined) throw terminationFailure;
      if (primaryFailure instanceof Error) {
        Object.defineProperty(primaryFailure, "cause", {
          configurable: true,
          value: terminationFailure,
        });
      }
    }
  }
}
