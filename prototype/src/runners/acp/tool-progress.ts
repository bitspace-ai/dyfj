/** Ephemeral per-turn display state, never tool evidence or replay input. */
import { historyTextContainsSecretShape } from "../../acp-history-bounds.ts";
import type { AcpToolEvidenceAccumulator } from "../../acp-tool-evidence.ts";
import type { WorkbenchRuntimeEvent } from "../../contract/mod.ts";
import {
  containsSensitiveShape,
  sanitizeBoundaryText,
  scrubSensitiveShapes,
  takeCodePointPrefix,
  utf8ByteLengthWithinLimit,
} from "../../kernel/mod.ts";

export type AcpProgressUpdate = Omit<
  Extract<WorkbenchRuntimeEvent, { type: "agentProgress" }>,
  "type" | "sessionId"
>;
type Summary = Pick<AcpProgressUpdate, "input" | "cwd" | "locations" | "inputWithheld">;
export interface ToolProgressState {
  title?: string;
  status?: string;
  summary?: Summary;
  summarySent?: boolean;
}

/** An ellipsis is included in the byte budget whenever a display value is cut. */
function displayValue(raw: string, bytes: number): string {
  const safe = sanitizeBoundaryText(raw, Infinity);
  return utf8ByteLengthWithinLimit(safe, bytes) === undefined
    ? `${sanitizeBoundaryText(safe, bytes - 3)}…`
    : safe;
}

function metadata(value: unknown, workspace?: string): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  let safe = scrubSensitiveShapes(sanitizeBoundaryText(value, Infinity));
  if (historyTextContainsSecretShape(safe)) return "[withheld]";
  if (workspace !== undefined) {
    safe = safe.replaceAll(`${withoutTrailingSlashes(sanitizeBoundaryText(workspace, Infinity))}/`, "");
  }
  return takeCodePointPrefix(safe, 256).join("");
}

function toolKind(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const safe = scrubSensitiveShapes(sanitizeBoundaryText(value, Infinity));
  return historyTextContainsSecretShape(safe) ? undefined : displayValue(safe, 128);
}

function withoutTrailingSlashes(path: string): string {
  return path.replace(/\/+$/, "");
}

function locationWithinWorkspace(path: string, workspace: string): string {
  const root = withoutTrailingSlashes(workspace);
  const prefix = `${root}/`;
  return !path.split("/").includes("..") && path.startsWith(prefix) &&
      withoutTrailingSlashes(path) !== root
    ? path.slice(prefix.length) : path;
}

function summaryPatch(update: Record<string, unknown>, workspace: string): Summary | undefined {
  const raw = update.rawInput;
  const input = raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown> : {};
  const command = typeof input.command === "string" ? input.command
    : Array.isArray(input.command) && input.command.every((part) => typeof part === "string")
    ? input.command.join(" ") : undefined;
  const cwd = typeof input.cwd === "string" ? input.cwd : undefined;
  const locations = Array.isArray(update.locations)
    ? update.locations.flatMap((location) =>
      location !== null && typeof location === "object" && typeof location.path === "string"
        ? [location.path as string] : [])
    : [];
  if (command === undefined && locations.length === 0) return undefined;
  // Check raw and terminal-sanitized full values, including undisplayed paths,
  // before cutting. Never retain a scrubbed copy of a withheld summary.
  if ([command, cwd, ...locations].some((value) => value !== undefined && (
    containsSensitiveShape(value) || containsSensitiveShape(sanitizeBoundaryText(value, Infinity)) ||
    historyTextContainsSecretShape(value)
  ))) {
    return { inputWithheld: true };
  }
  return {
    ...(command === undefined ? {} : { input: displayValue(command, 240) }),
    ...(command === undefined || cwd === undefined || withoutTrailingSlashes(cwd) === withoutTrailingSlashes(workspace)
      ? {} : { cwd: displayValue(cwd, 240) }),
    ...(locations.length === 0 ? {} : { locations: locations.slice(0, 3).map((path) => displayValue(locationWithinWorkspace(path, workspace), 240)) }),
  };
}

/** Called only after the evidence accumulator has applied the patch. */
export function toolCallProgress(
  update: Record<string, unknown>,
  evidence: AcpToolEvidenceAccumulator,
  states: Map<string, ToolProgressState>,
  workspace: string,
): AcpProgressUpdate | null {
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return null;
  // Do not clip identity: two long IDs can share a prefix. Such updates keep
  // the legacy per-update display path, without a toolCallId.
  const usableId = typeof update.toolCallId === "string" &&
    utf8ByteLengthWithinLimit(update.toolCallId, 128) !== undefined &&
    !containsSensitiveShape(update.toolCallId);
  const call = usableId ? evidence.calls.get(update.toolCallId as string) : undefined;
  const merged = call ?? update;
  const id = call?.toolCallId;
  const previous = id === undefined ? undefined : states.get(id);
  const state: ToolProgressState = previous ?? {};
  const raw = update.rawInput;
  const mcp = call?.mcp === true ||
    (typeof merged.title === "string" && merged.title.startsWith("mcp.")) ||
    (raw !== null && typeof raw === "object" && "server" in raw && "tool" in raw && "arguments" in raw);
  if (id === undefined || mcp) state.summary = undefined;
  else if (!state.summarySent && !state.summary?.inputWithheld) {
    const patch = summaryPatch(update, workspace);
    if (patch?.inputWithheld) state.summary = patch;
    else if (patch !== undefined) state.summary = { ...state.summary, ...patch };
  }
  const changed = previous === undefined || state.title !== merged.title || state.status !== merged.status;
  state.title = typeof merged.title === "string" ? merged.title : undefined;
  state.status = typeof merged.status === "string" ? merged.status : undefined;
  if (id !== undefined) states.set(id, state);
  if (!changed) return null;
  const progress: AcpProgressUpdate = {
    kind: "tool_call",
    ...(id === undefined ? {} : { toolCallId: id }),
    title: metadata(merged.title, workspace),
    name: metadata(merged.name),
    toolKind: toolKind(merged.kind),
    status: metadata(merged.status),
    ...(!mcp && !state.summarySent ? state.summary : {}),
  };
  if (state.summary !== undefined) state.summarySent = true;
  return progress;
}
