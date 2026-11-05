/**
 * Capture of an external agent's tool calls from the ACP update stream. Each
 * call is merged across its `tool_call` and `tool_call_update` patches and
 * judged on its own: a problem marks only that call, by a fixed reason code.
 */
import { clipToUtf8Bytes, utf8ByteLengthWithinLimit } from "./kernel/mod.ts";
import {
  ACP_TOOL_EVIDENCE_REASONS,
  type AcpToolEvidenceReason,
} from "./contract/mod.ts";
import {
  historyValueContainsSecretShape,
  objectKeysAndValues,
} from "./acp-history-bounds.ts";

/** ACP tool-call statuses Workbench keeps; any other value is dropped. */
export type AcpToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

/**
 * One observed ACP tool call, merged across its `tool_call` and
 * `tool_call_update` patches. Every field is bounded. A field whose value
 * failed a capture rule is absent, and `problems` names the rule by a fixed
 * code; the failing value itself is never kept. An oversized output is the one
 * exception: it is kept cut to the bound, ending in
 * `ACP_TOOL_OUTPUT_TRUNCATION_MARKER`, and reported as `oversized_output`.
 */
export interface AcpToolCallEvidence {
  toolCallId?: string;
  title?: string;
  name?: string;
  kind?: string;
  status?: AcpToolCallStatus;
  rawInputJson?: string;
  rawOutputJson?: string;
  /** Capture-time problems in precedence order; empty for a complete call. */
  problems: AcpToolEvidenceReason[];
}

/**
 * Bounded tool evidence observed on the ACP update stream: one entry per
 * distinct usable call id, plus at most one entry for every update that had no
 * usable id, in the order each first appeared. `unavailable` means no call could be attributed (the turn was aborted); it
 * carries no raw values.
 */
export type AcpToolEvidence =
  | {
    status: "captured";
    observedCalls: number;
    calls: AcpToolCallEvidence[];
  }
  | {
    status: "unavailable";
    observedCalls: number;
    calls: [];
  };

export const MAX_ACP_TOOL_EVIDENCE_FIELD_BYTES = 8_192;

/** Ends an output kept cut to `MAX_ACP_TOOL_EVIDENCE_FIELD_BYTES`. */
export const ACP_TOOL_OUTPUT_TRUNCATION_MARKER =
  `\n[dyfj: tool output truncated to ${MAX_ACP_TOOL_EVIDENCE_FIELD_BYTES} bytes; the rest was not recorded]`;

const ACP_TOOL_CALL_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "in_progress",
  "completed",
  "failed",
]);

interface MutableAcpToolCallEvidence {
  toolCallId?: string;
  title?: string;
  name?: string;
  kind?: string;
  status?: AcpToolCallStatus;
  rawInputJson?: string;
  rawOutputJson?: string;
  /** Sticky: the call's identity or stream shape was wrong. */
  malformed: boolean;
  /** Reset whenever a later patch replaces the field. */
  inputProblem?: AcpToolEvidenceReason;
  outputProblem?: AcpToolEvidenceReason;
}

export interface AcpToolEvidenceAccumulator {
  /** Every entry, in the order its first update arrived. */
  entries: MutableAcpToolCallEvidence[];
  calls: Map<string, MutableAcpToolCallEvidence>;
  /**
   * The one entry for every update with no usable call id. How many calls
   * those updates describe cannot be known, so they count as one rejected
   * entry, placed where the first of them arrived.
   */
  unattributed?: MutableAcpToolCallEvidence;
}

type BoundedJson =
  | { kind: "ok"; json: string }
  | { kind: "oversized"; json: string }
  | { kind: "oversized_dropped" }
  | { kind: "credential_shaped" }
  | { kind: "malformed" };

/**
 * Whether `value`, a parsed JSON value, surely serializes to more than
 * `limitBytes`. It sums a lower bound of the serialized length (each string's
 * code units and quotes, one unit per scalar, brackets and array separators)
 * and stops as soon as the bound passes the limit, so the work is bounded by
 * the limit, not by the value. A UTF-8 encoding is never shorter than the
 * string's code units.
 */
function surelyExceedsJsonBytes(value: unknown, limitBytes: number): boolean {
  let total = 0;
  const frames: Iterator<unknown>[] = [[value][Symbol.iterator]()];
  while (frames.length > 0) {
    const next = frames[frames.length - 1].next();
    if (next.done === true) {
      frames.pop();
      continue;
    }
    const part = next.value;
    if (typeof part === "string") total += part.length + 2;
    else if (Array.isArray(part)) {
      total += 1 + part.length;
      frames.push(part[Symbol.iterator]());
    } else if (part !== null && typeof part === "object") {
      total += 2;
      frames.push(objectKeysAndValues(part));
    } else if (part !== undefined) total += 1;
    if (total > limitBytes) return true;
  }
  return false;
}

/**
 * Serialize one raw value and check it before any part of it is kept. The
 * credential check reads the whole value, serialized and decoded, before any
 * cut. A value that will not be kept at all when oversized (`keepOversized`
 * false, as for an input) is measured before it is serialized and is not
 * scanned: it is reported oversized and nothing of it is kept.
 */
function boundedJson(value: unknown, keepOversized: boolean): BoundedJson {
  if (
    !keepOversized &&
    surelyExceedsJsonBytes(value, MAX_ACP_TOOL_EVIDENCE_FIELD_BYTES)
  ) {
    return { kind: "oversized_dropped" };
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return { kind: "malformed" };
  }
  if (json === undefined) return { kind: "malformed" };
  const oversized =
    utf8ByteLengthWithinLimit(json, MAX_ACP_TOOL_EVIDENCE_FIELD_BYTES) ===
      undefined;
  if (oversized && !keepOversized) return { kind: "oversized_dropped" };
  if (historyValueContainsSecretShape(value, json)) {
    return { kind: "credential_shaped" };
  }
  return oversized ? { kind: "oversized", json } : { kind: "ok", json };
}

function truncatedToolOutput(json: string): string {
  const markerBytes = new TextEncoder().encode(
    ACP_TOOL_OUTPUT_TRUNCATION_MARKER,
  ).byteLength;
  const kept = clipToUtf8Bytes(
    json,
    MAX_ACP_TOOL_EVIDENCE_FIELD_BYTES - markerBytes,
  ) ?? json;
  return `${kept}${ACP_TOOL_OUTPUT_TRUNCATION_MARKER}`;
}

function optionalToolField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 &&
      utf8ByteLengthWithinLimit(value, MAX_ACP_TOOL_EVIDENCE_FIELD_BYTES) !==
        undefined
    ? value
    : undefined;
}

/**
 * Merge one session update into the call it names. A problem marks only that
 * call; every other call in the turn is unaffected.
 */
export function applyAcpToolPatch(
  accumulator: AcpToolEvidenceAccumulator,
  update: Record<string, unknown>,
): void {
  if (
    update.sessionUpdate !== "tool_call" &&
    update.sessionUpdate !== "tool_call_update"
  ) {
    return;
  }
  const toolCallId = optionalToolField(update.toolCallId);
  if (toolCallId === undefined) {
    if (accumulator.unattributed === undefined) {
      accumulator.unattributed = { malformed: true };
      accumulator.entries.push(accumulator.unattributed);
    }
    return;
  }
  let call = accumulator.calls.get(toolCallId);
  if (call === undefined) {
    call = { toolCallId, malformed: update.sessionUpdate !== "tool_call" };
    accumulator.calls.set(toolCallId, call);
    accumulator.entries.push(call);
  } else if (update.sessionUpdate === "tool_call") {
    // A second announcement of the same id cannot be told apart from a
    // different call reusing it.
    call.malformed = true;
  }
  const patchString = (key: "title" | "name" | "kind"): void => {
    if (!Object.hasOwn(update, key)) return;
    const value = optionalToolField(update[key]);
    if (value === undefined) {
      if (
        key === "name" && update.sessionUpdate === "tool_call_update" &&
        update[key] === null
      ) {
        return;
      }
      if (update[key] !== null) call!.malformed = true;
      delete call![key];
      return;
    }
    call![key] = value;
  };
  patchString("title");
  patchString("name");
  patchString("kind");
  if (Object.hasOwn(update, "status")) {
    const status = update.status;
    if (typeof status === "string" && ACP_TOOL_CALL_STATUSES.has(status)) {
      call.status = status as AcpToolCallStatus;
    } else {
      // An unknown status is dropped, so the call reads as unfinished.
      delete call.status;
    }
  }
  if (Object.hasOwn(update, "rawInput")) {
    const input = boundedJson(update.rawInput, false);
    delete call.rawInputJson;
    delete call.inputProblem;
    if (input.kind === "ok") call.rawInputJson = input.json;
    else {
      call.inputProblem =
        input.kind === "oversized" || input.kind === "oversized_dropped"
          ? "oversized_input"
          : input.kind;
    }
  }
  if (Object.hasOwn(update, "rawOutput")) {
    const output = boundedJson(update.rawOutput, true);
    delete call.rawOutputJson;
    delete call.outputProblem;
    if (output.kind === "ok") call.rawOutputJson = output.json;
    else if (output.kind === "oversized") {
      call.rawOutputJson = truncatedToolOutput(output.json);
      call.outputProblem = "oversized_output";
    } else {
      call.outputProblem = output.kind === "oversized_dropped"
        ? "oversized_output"
        : output.kind;
    }
  }
}

function callProblems(
  call: MutableAcpToolCallEvidence,
): AcpToolEvidenceReason[] {
  const problems = new Set<AcpToolEvidenceReason>();
  if (call.malformed) problems.add("malformed");
  if (call.name === undefined && call.kind === undefined) {
    problems.add("malformed");
  }
  if (call.inputProblem !== undefined) problems.add(call.inputProblem);
  else if (call.rawInputJson === undefined) problems.add("missing_raw_input");
  if (call.outputProblem !== undefined) problems.add(call.outputProblem);
  else if (call.rawOutputJson === undefined) {
    problems.add("missing_raw_output");
  }
  if (call.status !== "completed" && call.status !== "failed") {
    problems.add("incomplete_status");
  }
  return ACP_TOOL_EVIDENCE_REASONS.filter((reason) => problems.has(reason));
}

export function finishAcpToolEvidence(
  accumulator: AcpToolEvidenceAccumulator,
): AcpToolEvidence {
  const calls: AcpToolCallEvidence[] = [];
  for (const call of accumulator.entries) {
    const problems = callProblems(call);
    // A credential-shaped call keeps neither raw field, even the one that
    // passed on its own.
    const keepRaw = !problems.includes("credential_shaped");
    calls.push({
      ...(call.toolCallId === undefined ? {} : { toolCallId: call.toolCallId }),
      ...(call.title === undefined ? {} : { title: call.title }),
      ...(call.name === undefined ? {} : { name: call.name }),
      ...(call.kind === undefined ? {} : { kind: call.kind }),
      ...(call.status === undefined ? {} : { status: call.status }),
      ...(!keepRaw || call.rawInputJson === undefined
        ? {}
        : { rawInputJson: call.rawInputJson }),
      ...(!keepRaw || call.rawOutputJson === undefined
        ? {}
        : { rawOutputJson: call.rawOutputJson }),
      problems,
    });
  }
  return { status: "captured", observedCalls: calls.length, calls };
}

export function newAcpToolEvidenceAccumulator(): AcpToolEvidenceAccumulator {
  return { entries: [], calls: new Map() };
}
