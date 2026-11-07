/**
 * `dyfj sessions` and `dyfj sessions show <ref> --events [--json]`:
 * list sessions grouped by project, or read back up to 1,000 persisted events
 * for one session as ordered turns and tool events over the runtime's UDS
 * JSON-RPC seam.
 */

import {
  ACP_TOOL_EVIDENCE_REASONS,
  ACP_TOOL_EVIDENCE_REJECTING_REASONS,
  ACP_TOOL_HISTORY_UNAVAILABLE_NAME,
  type AcpToolEvidenceReason,
  type AcpToolEvidenceReasonCounts,
  formatAcpToolEvidenceLine,
  type WorkbenchSessionEvent,
} from "../../contract/mod.ts";
import {
  clipToUtf8Bytes,
  containsSensitiveShape,
  scrubSensitiveShapes,
} from "../../kernel/mod.ts";
import { connectUnixClient } from "../../transport/mod.ts";
import type { CliConfig } from "../args.ts";
import type { ConnectFn, Io } from "../io.ts";
import { socketError } from "../render/errors.ts";

/** Maximum UTF-8 byte length (including trailing ellipsis) for a recorded `session_start` or response `content` first-line preview. */
export const MAX_SESSION_EVENT_LINE_BYTES = 200;

/** Maximum UTF-8 byte length (including trailing ellipsis) for a persisted tool call's checked input preview. */
export const MAX_SESSION_EVENT_INPUT_BYTES = 240;

const ELLIPSIS = "…";
const ELLIPSIS_UTF8_BYTES = 3;
const MAX_SENSITIVE_SCAN_CHARS = 1024;
const MAX_PREVIEW_BUILD_CHARS = MAX_SESSION_EVENT_INPUT_BYTES + 32;
const MAX_PREVIEW_DEPTH = 12;
const MAX_PREVIEW_STEPS = 64;

const MAX_TOOL_ID_BYTES = 128;
const MAX_TOOL_NAME_BYTES = 128;
const MAX_TOOL_KIND_BYTES = 128;
const MAX_TOOL_TITLE_BYTES = 200;
const MAX_TOOL_STATUS_BYTES = 64;
export const SESSION_EVENTS_QUERY_LIMIT = 1000;

interface SessionRow {
  slug?: string;
  sessionName?: string;
  updatedAt?: string;
}
interface ProjectGroup {
  project: string | null;
  sessions: SessionRow[];
}

export interface SessionTurnToolEventView {
  toolCallId: string | null;
  outcome: "recorded" | "partial" | "rejected" | "unavailable";
  toolName: string;
  kind: string | null;
  title: string | null;
  status: string | null;
  reason: string | null;
  input: string | null;
}

export interface SessionTurnEventsView {
  turn: number;
  traceId: string;
  runner: "external_agent" | "native";
  promptFirstLine: string;
  replyFirstLine: string;
  toolEvidenceLine: string;
  toolEvents: SessionTurnToolEventView[];
}

export interface SessionEventsReadback {
  sessionId: string;
  truncated: boolean;
  turns: SessionTurnEventsView[];
}

function stripControlChars(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13) {
      out += " ";
      continue;
    }
    if (code <= 31 || code === 127 || (code >= 128 && code <= 159)) continue;
    out += ch;
  }
  return out;
}

function clipWithEllipsis(text: string, maxBytes: number): string {
  if (clipToUtf8Bytes(text, maxBytes) === null) return text;
  const prefixBudget = Math.max(0, maxBytes - ELLIPSIS_UTF8_BYTES);
  const clipped = clipToUtf8Bytes(text, prefixBudget);
  return `${clipped ?? ""}${ELLIPSIS}`;
}

function firstLineForReadback(raw: string | null | undefined): string {
  if (typeof raw !== "string" || raw.length === 0) return "";
  const scanWindow = raw.length > MAX_SENSITIVE_SCAN_CHARS
    ? raw.slice(0, MAX_SENSITIVE_SCAN_CHARS)
    : raw;
  const newlineIdx = scanWindow.search(/[\r\n]/);
  const first = newlineIdx === -1 ? scanWindow : scanWindow.slice(0, newlineIdx);
  const bounded = newlineIdx === -1 && raw.length > MAX_SENSITIVE_SCAN_CHARS
    ? `${first}${ELLIPSIS}`
    : first;
  const cleaned = scrubSensitiveShapes(stripControlChars(bounded));
  return clipWithEllipsis(cleaned, MAX_SESSION_EVENT_LINE_BYTES);
}

function sanitizeToolLabel(value: unknown, maxBytes: number): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_SENSITIVE_SCAN_CHARS
  ) {
    return null;
  }
  const cleaned = stripControlChars(value);
  if (
    cleaned.length === 0 ||
    containsSensitiveShape(value) ||
    containsSensitiveShape(cleaned)
  ) {
    return null;
  }
  return clipWithEllipsis(cleaned, maxBytes);
}

interface BoundedPreviewState {
  out: string;
  readonly budget: number;
  steps: number;
  sensitive: boolean;
}

/**
 * Append an object's preview entries until `state.budget` or
 * `MAX_PREVIEW_STEPS` traversal thresholds are reached, stopping before reading
 * further property values or entering nested objects once either threshold is
 * reached (JSON string escaping on a kept slice can briefly exceed
 * `state.budget` before `formatBoundedToolInput` strips control characters and
 * clips the final preview to `MAX_SESSION_EVENT_INPUT_BYTES`). Listing a
 * visited object's own keys with `for...in` still costs V8 time and memory in
 * proportion to that object's key count (bounded on the wire by the UDS
 * transport's 16 MiB frame limit, and for ACP records by the 4 KiB / 64-node
 * history argument bound).
 */
function appendBoundedObjectPreview(
  record: Record<string, unknown>,
  depth: number,
  state: BoundedPreviewState,
): void {
  state.out += "{";
  let count = 0;
  for (const k in record) {
    if (
      state.out.length + (count > 0 ? 1 : 0) >= state.budget ||
      state.steps >= MAX_PREVIEW_STEPS
    ) {
      if (count > 0) state.out += ",";
      state.out += ELLIPSIS;
      break;
    }
    state.steps += 1;
    if (!Object.hasOwn(record, k)) continue;
    if (containsSensitiveShape(k.slice(0, MAX_SENSITIVE_SCAN_CHARS))) {
      state.sensitive = true;
      return;
    }
    const v = record[k];
    if (v === undefined || typeof v === "function" || typeof v === "symbol") {
      continue;
    }
    if (count > 0) state.out += ",";
    count += 1;
    const remaining = Math.max(0, state.budget - state.out.length);
    const keyJson = JSON.stringify(k.slice(0, remaining));
    state.out += `${keyJson}:`;
    if (state.out.length >= state.budget || state.steps >= MAX_PREVIEW_STEPS) {
      state.out += JSON.stringify(ELLIPSIS);
      break;
    }
    appendBoundedJsonPreview(v, depth + 1, state);
    if (state.sensitive) return;
  }
  state.out += "}";
}

function appendBoundedJsonPreview(
  value: unknown,
  depth: number,
  state: BoundedPreviewState,
): void {
  if (value === null) {
    state.out += "null";
    return;
  }
  if (typeof value === "boolean") {
    state.out += String(value);
    return;
  }
  if (typeof value === "number") {
    state.out += Number.isFinite(value) ? String(value) : "null";
    return;
  }
  if (typeof value === "string") {
    if (containsSensitiveShape(value.slice(0, MAX_SENSITIVE_SCAN_CHARS))) {
      state.sensitive = true;
      return;
    }
    const remaining = Math.max(0, state.budget - state.out.length);
    const slice = value.length > remaining ? value.slice(0, remaining) : value;
    state.out += JSON.stringify(slice);
    return;
  }
  if (
    depth >= MAX_PREVIEW_DEPTH ||
    state.out.length >= state.budget ||
    state.steps >= MAX_PREVIEW_STEPS
  ) {
    state.out += JSON.stringify(ELLIPSIS);
    return;
  }
  if (Array.isArray(value)) {
    state.out += "[";
    for (let i = 0; i < value.length; i += 1) {
      if (
        state.out.length + (i > 0 ? 1 : 0) >= state.budget ||
        state.steps >= MAX_PREVIEW_STEPS
      ) {
        if (i > 0) state.out += ",";
        state.out += ELLIPSIS;
        break;
      }
      state.steps += 1;
      if (i > 0) state.out += ",";
      const item = value[i];
      if (
        item === undefined ||
        typeof item === "function" ||
        typeof item === "symbol"
      ) {
        state.out += "null";
        continue;
      }
      appendBoundedJsonPreview(item, depth + 1, state);
      if (state.sensitive) return;
    }
    state.out += "]";
    return;
  }
  if (typeof value === "object") {
    appendBoundedObjectPreview(
      value as Record<string, unknown>,
      depth,
      state,
    );
  }
}

function serializeBoundedJsonPreview(
  value: unknown,
  budget: number,
): { text: string; sensitive: boolean } | null {
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    return null;
  }
  const state: BoundedPreviewState = {
    out: "",
    budget,
    steps: 0,
    sensitive: false,
  };
  appendBoundedJsonPreview(value, 0, state);
  return { text: state.out, sensitive: state.sensitive };
}

function formatBoundedToolInput(value: unknown): string | null {
  if (value === undefined) return null;
  const preview = serializeBoundedJsonPreview(value, MAX_PREVIEW_BUILD_CHARS);
  if (preview === null || preview.sensitive || preview.text.length === 0) return null;
  const cleaned = stripControlChars(preview.text);
  const unescapedQuotes = cleaned.replace(/\\"/g, '"');
  if (
    containsSensitiveShape(preview.text) ||
    containsSensitiveShape(cleaned) ||
    containsSensitiveShape(unescapedQuotes)
  ) {
    return null;
  }
  return clipWithEllipsis(cleaned, MAX_SESSION_EVENT_INPUT_BYTES);
}

function isAcpToolEvidenceReason(value: unknown): value is AcpToolEvidenceReason {
  return typeof value === "string" &&
    (ACP_TOOL_EVIDENCE_REASONS as readonly string[]).includes(value);
}

function isExternalAgentEvent(event: WorkbenchSessionEvent): boolean {
  return event.runnerKind === "external_agent" ||
    event.runnerProtocol === "acp" ||
    event.eventType === "runner_selected" ||
    event.eventType === "agent_response" ||
    event.eventType === "agent_permission" ||
    (event.eventType === "tool_call" &&
      (event.toolName === ACP_TOOL_HISTORY_UNAVAILABLE_NAME ||
        (typeof event.toolName === "string" && event.toolName.startsWith("acp."))));
}

function projectAcpGapToolEvent(event: WorkbenchSessionEvent): SessionTurnToolEventView {
  const args = event.toolArguments ?? {};
  const hasPerCallGap =
    (args.outcome === "partial" || args.outcome === "rejected") || "reason" in args;
  if (!hasPerCallGap) {
    return {
      toolCallId: sanitizeToolLabel(event.toolCallId, MAX_TOOL_ID_BYTES),
      outcome: "unavailable",
      toolName: ACP_TOOL_HISTORY_UNAVAILABLE_NAME,
      kind: null,
      title: null,
      status: null,
      reason: "unavailable",
      input: null,
    };
  }
  const reason: AcpToolEvidenceReason = isAcpToolEvidenceReason(args.reason)
    ? args.reason
    : "malformed";
  const rejected = args.outcome === "rejected" ||
    ACP_TOOL_EVIDENCE_REJECTING_REASONS.has(reason);
  return {
    toolCallId: sanitizeToolLabel(
      typeof args.toolCallId === "string" ? args.toolCallId : event.toolCallId,
      MAX_TOOL_ID_BYTES,
    ),
    outcome: rejected ? "rejected" : "partial",
    toolName: sanitizeToolLabel(args.toolName, MAX_TOOL_NAME_BYTES) ??
      ACP_TOOL_HISTORY_UNAVAILABLE_NAME,
    kind: sanitizeToolLabel(args.kind, MAX_TOOL_KIND_BYTES),
    title: sanitizeToolLabel(args.title, MAX_TOOL_TITLE_BYTES),
    status: sanitizeToolLabel(args.status, MAX_TOOL_STATUS_BYTES),
    reason,
    input: rejected || !("input" in args) ? null : formatBoundedToolInput(args.input),
  };
}

function projectToolEvent(
  event: WorkbenchSessionEvent,
  runner: "external_agent" | "native",
): SessionTurnToolEventView {
  const validRecord = event.toolHistoryValid !== false &&
    event.toolName !== null &&
    event.toolCallId !== null &&
    event.toolArguments !== null &&
    event.toolResult !== null &&
    event.toolIsError !== null;
  if (!validRecord) {
    return {
      toolCallId: sanitizeToolLabel(event.toolCallId, MAX_TOOL_ID_BYTES),
      outcome: "rejected",
      toolName: sanitizeToolLabel(event.toolName, MAX_TOOL_NAME_BYTES) ??
        (runner === "external_agent" ? ACP_TOOL_HISTORY_UNAVAILABLE_NAME : "unknown"),
      kind: null,
      title: null,
      status: event.toolIsError === true
        ? "failed"
        : event.toolIsError === false
        ? "completed"
        : null,
      reason: "malformed",
      input: null,
    };
  }
  if (event.toolName === ACP_TOOL_HISTORY_UNAVAILABLE_NAME) {
    return projectAcpGapToolEvent(event);
  }
  const args = event.toolArguments!;
  const isExternal = runner === "external_agent";
  const rawInput = isExternal && "input" in args ? args.input : args;
  return {
    toolCallId: sanitizeToolLabel(event.toolCallId, MAX_TOOL_ID_BYTES),
    outcome: "recorded",
    toolName: sanitizeToolLabel(event.toolName, MAX_TOOL_NAME_BYTES) ??
      (isExternal ? "acp.unknown" : "unknown"),
    kind: isExternal ? sanitizeToolLabel(args.kind, MAX_TOOL_KIND_BYTES) : null,
    title: isExternal ? sanitizeToolLabel(args.title, MAX_TOOL_TITLE_BYTES) : null,
    status: event.toolIsError ? "failed" : "completed",
    reason: null,
    input: formatBoundedToolInput(rawInput),
  };
}

function formatTurnToolEvidenceLine(
  runner: "external_agent" | "native",
  toolEvents: readonly SessionTurnToolEventView[],
): string {
  if (runner === "external_agent") {
    const partialReasons: AcpToolEvidenceReasonCounts = {};
    const rejectedReasons: AcpToolEvidenceReasonCounts = {};
    let recordedCalls = 0;
    let partialCalls = 0;
    let rejectedCalls = 0;
    let unavailableCount = 0;
    for (const item of toolEvents) {
      if (item.outcome === "unavailable") {
        unavailableCount += 1;
        continue;
      }
      if (item.outcome === "recorded") {
        recordedCalls += 1;
        continue;
      }
      const code = isAcpToolEvidenceReason(item.reason)
        ? item.reason
        : "malformed";
      if (item.outcome === "partial") {
        partialCalls += 1;
        partialReasons[code] = (partialReasons[code] ?? 0) + 1;
      } else {
        rejectedCalls += 1;
        rejectedReasons[code] = (rejectedReasons[code] ?? 0) + 1;
      }
    }
    const observedCalls = recordedCalls + partialCalls + rejectedCalls;
    if (unavailableCount > 0 && observedCalls === 0) {
      return "ACP tool evidence: unavailable (none recorded)";
    }
    const summaryLine = formatAcpToolEvidenceLine({
      status: partialCalls === 0 && rejectedCalls === 0 && unavailableCount === 0
        ? "complete"
        : "partial",
      observedCalls,
      recordedCalls,
      partialCalls,
      rejectedCalls,
      partialReasons,
      rejectedReasons,
    });
    return unavailableCount > 0
      ? `${summaryLine} (${unavailableCount} unavailable)`
      : summaryLine;
  }
  let recordedCalls = 0;
  let okCalls = 0;
  let errorCalls = 0;
  let rejectedCalls = 0;
  for (const item of toolEvents) {
    if (item.outcome === "recorded") {
      recordedCalls += 1;
      if (item.status === "failed") errorCalls += 1;
      else okCalls += 1;
    } else {
      rejectedCalls += 1;
    }
  }
  const observedCalls = recordedCalls + rejectedCalls;
  const rejectedClause = rejectedCalls > 0
    ? `, ${rejectedCalls} rejected (malformed)`
    : "";
  return `Native tool evidence: ${recordedCalls} recorded (${okCalls} ok, ${errorCalls} error)${rejectedClause} of ${observedCalls}`;
}

/**
 * Project persisted `WorkbenchSessionEvent` rows into ordered turns and
 * value-checked tool events for CLI readback.
 */
export function projectSessionEventsReadback(
  sessionId: string,
  events: readonly WorkbenchSessionEvent[],
  queryLimit = SESSION_EVENTS_QUERY_LIMIT,
): SessionEventsReadback {
  interface TurnBucket {
    traceId: string;
    hasSessionStart: boolean;
    events: WorkbenchSessionEvent[];
  }
  const buckets: TurnBucket[] = [];
  const latestByTrace = new Map<string, TurnBucket>();
  for (const event of events) {
    const rawTrace = typeof event.traceId === "string" && event.traceId.length > 0
      ? event.traceId
      : "unknown";
    const traceId = sanitizeToolLabel(rawTrace, MAX_TOOL_ID_BYTES) ?? "unknown";
    const existing = latestByTrace.get(traceId);
    if (
      existing === undefined ||
      (event.eventType === "session_start" && existing.hasSessionStart)
    ) {
      const bucket: TurnBucket = {
        traceId,
        hasSessionStart: event.eventType === "session_start",
        events: [event],
      };
      buckets.push(bucket);
      latestByTrace.set(traceId, bucket);
    } else {
      if (event.eventType === "session_start") existing.hasSessionStart = true;
      existing.events.push(event);
    }
  }

  const turns: SessionTurnEventsView[] = buckets.map((bucket, idx) => {
    const runner = bucket.events.some(isExternalAgentEvent)
      ? "external_agent"
      : "native";
    const startEvent = bucket.events.find((e) => e.eventType === "session_start");
    let responseEvent: WorkbenchSessionEvent | undefined;
    for (const event of bucket.events) {
      if (
        event.eventType === "agent_response" ||
        event.eventType === "model_response"
      ) {
        responseEvent = event;
      }
    }
    const toolEvents = bucket.events
      .filter((event) => event.eventType === "tool_call")
      .map((event) => projectToolEvent(event, runner));
    return {
      turn: idx + 1,
      traceId: bucket.traceId,
      runner,
      promptFirstLine: firstLineForReadback(startEvent?.content),
      replyFirstLine: firstLineForReadback(responseEvent?.content),
      toolEvidenceLine: formatTurnToolEvidenceLine(runner, toolEvents),
      toolEvents,
    };
  });

  return {
    sessionId,
    truncated: queryLimit > 0 && events.length >= queryLimit,
    turns,
  };
}

function formatToolEventLine(
  index: number,
  item: SessionTurnToolEventView,
): string {
  const parts = [`    ${index + 1}. [${item.outcome}] ${item.toolName}`];
  if (item.kind !== null) parts.push(`kind=${item.kind}`);
  if (item.status !== null) parts.push(`status=${item.status}`);
  if (item.reason !== null) parts.push(`reason=${item.reason}`);
  if (item.title !== null) parts.push(`title=${JSON.stringify(item.title)}`);
  if (item.input !== null) parts.push(`input=${item.input}`);
  return parts.join(" · ");
}

/** Format `SessionEventsReadback` for terminal output. */
export function formatSessionEventsReadback(
  readback: SessionEventsReadback,
): string {
  const turnWord = readback.turns.length === 1 ? "turn" : "turns";
  const truncatedNote = readback.truncated
    ? "; truncated at event query limit, final turn may be incomplete"
    : "";
  const lines = [
    `Session ${readback.sessionId} (${readback.turns.length} ${turnWord}${truncatedNote})`,
  ];
  for (const turn of readback.turns) {
    lines.push(
      "",
      `Turn ${turn.turn} [${turn.runner} · trace ${turn.traceId}]`,
      `  Prompt: ${turn.promptFirstLine || "(empty)"}`,
      `  Reply:  ${turn.replyFirstLine || "(empty)"}`,
      `  ${turn.toolEvidenceLine}`,
    );
    if (turn.toolEvents.length === 0) {
      lines.push("  Tool events: (none)");
    } else {
      lines.push("  Tool events:");
      turn.toolEvents.forEach((item, idx) => {
        lines.push(formatToolEventLine(idx, item));
      });
    }
  }
  return lines.join("\n");
}

export async function runSessionEvents(
  sessionId: string,
  config: CliConfig,
  io: Io,
  json = false,
  connect: ConnectFn = connectUnixClient,
): Promise<number> {
  try {
    const client = await connect(config.socket);
    let events: WorkbenchSessionEvent[];
    try {
      const response = await client.request("events/query", {
        sessionId,
        limit: SESSION_EVENTS_QUERY_LIMIT,
      }) as { events?: WorkbenchSessionEvent[] };
      events = Array.isArray(response?.events) ? response.events : [];
    } finally {
      client.close();
    }
    if (events.length === 0) {
      const message = `no recorded events for session ${sessionId}`;
      if (json) io.out(`${JSON.stringify({ error: message })}\n`);
      io.err(`dyfj: ${message}`);
      return 1;
    }
    const readback = projectSessionEventsReadback(sessionId, events);
    if (json) {
      io.out(`${JSON.stringify(readback, null, 2)}\n`);
    } else {
      io.out(`${formatSessionEventsReadback(readback)}\n`);
    }
    return 0;
  } catch (error) {
    const line = socketError(error, config);
    if (json) {
      io.out(`${JSON.stringify({ error: line.replace(/^dyfj: /, "") })}\n`);
    }
    io.err(line);
    return 1;
  }
}

export async function runSessions(
  config: CliConfig,
  io: Io,
  connect: ConnectFn = connectUnixClient,
): Promise<number> {
  try {
    const client = await connect(config.socket);
    try {
      const { projects } = await client.request("sessions/list") as {
        projects: ProjectGroup[];
      };
      for (const group of projects) {
        io.out(`\n${group.project ?? "(unfiled)"}\n`);
        for (const s of group.sessions) {
          const when = (s.updatedAt ?? "").slice(0, 16);
          io.out(
            `  ${(s.slug ?? "").padEnd(40)} ${when.padEnd(18)} ${
              s.sessionName ?? ""
            }\n`,
          );
        }
      }
      io.err(`resume one with: dyfj --session <session> (the first column)`);
    } finally {
      client.close();
    }
    return 0;
  } catch (error) {
    io.err(socketError(error, config));
    return 1;
  }
}
