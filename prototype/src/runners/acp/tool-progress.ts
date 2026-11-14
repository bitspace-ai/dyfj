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
  fileChanges?: AcpProgressUpdate["fileChanges"];
  fileChangesSent?: boolean;
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
  const root = workspace === undefined ? "" : withoutTrailingSlashes(sanitizeBoundaryText(workspace, Infinity));
  if (root !== "") safe = safe.replaceAll(`${root}/`, "");
  if (credentialShape(safe)) return "[withheld]";
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

/** The same whole-value checks used for command input, before display cuts. */
function credentialShape(value: string): boolean {
  return containsSensitiveShape(value) ||
    containsSensitiveShape(sanitizeBoundaryText(value, Infinity)) ||
    historyTextContainsSecretShape(value);
}

export function planProgress(update: Record<string, unknown>): AcpProgressUpdate | null {
  if (!Array.isArray(update.entries)) return null;
  const steps: NonNullable<AcpProgressUpdate["plan"]>["steps"] = [];
  let stepsOmitted = Math.max(0, update.entries.length - 20);
  for (const entry of update.entries.slice(0, 20)) {
    if (entry === null || typeof entry !== "object" || typeof entry.content !== "string" ||
      !["pending", "in_progress", "completed"].includes(entry.status)) {
      stepsOmitted++;
      continue;
    }
    steps.push({ content: credentialShape(entry.content) ? "[withheld]" : displayValue(entry.content, 160),
      status: entry.status });
  }
  return { kind: "plan", plan: { steps, ...(stepsOmitted ? { stepsOmitted } : {}) } };
}

function textLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Linear scans of entry text; retain at most forty candidate lines per shown path. */
function fileChanges(content: unknown, workspace: string): AcpProgressUpdate["fileChanges"] {
  if (!Array.isArray(content)) return undefined;
  type File = NonNullable<AcpProgressUpdate["fileChanges"]>["files"][number];
  const paths = new Map<string, File | null>();
  let filesOmitted = 0;
  let shown = 0;
  for (const entry of content) {
    if (entry === null || typeof entry !== "object" || entry.type !== "diff" ||
      typeof entry.path !== "string" || typeof entry.newText !== "string" ||
      !(entry.oldText === null || typeof entry.oldText === "string")) continue;
    const change = entry._meta?.kind === "add" ? "add" : entry._meta?.kind === "delete" ? "delete" : "update";
    if (!paths.has(entry.path)) {
      if (credentialShape(entry.path) || shown === 5) {
        paths.set(entry.path, null);
        filesOmitted++;
      } else {
        paths.set(entry.path, { path: displayValue(locationWithinWorkspace(entry.path, workspace), 240),
          change, added: 0, removed: 0, lines: [] });
        shown++;
      }
    }
    const file = paths.get(entry.path);
    if (!file) continue;
    if (credentialShape(entry.oldText ?? "") || credentialShape(entry.newText)) {
      file.withheld = true;
      delete file.lines;
    }
    const oldLines = change === "add" ? [] : textLines(entry.oldText ?? "");
    const newLines = change === "delete" ? [] : textLines(entry.newText);
    let start = 0;
    let oldEnd = oldLines.length;
    let newEnd = newLines.length;
    if (change === "update") {
      while (start < oldEnd && start < newEnd && oldLines[start] === newLines[start]) start++;
      while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
        oldEnd--; newEnd--;
      }
    }
    file.removed += oldEnd - start;
    file.added += newEnd - start;
    if (!file.withheld) {
      for (const [lines, end, sign] of [[oldLines, oldEnd, "-"], [newLines, newEnd, "+"]] as const) {
        for (let i = start; i < end && file.lines!.length < 40; i++) {
          file.lines!.push(displayValue(sign + lines[i], 200));
        }
      }
    }
  }
  if (paths.size === 0) return undefined;
  let remaining = 40;
  const files: File[] = [];
  for (const file of paths.values()) {
    if (!file) continue;
    if (!file.withheld) {
      file.lines = file.lines!.slice(0, remaining);
      remaining -= file.lines.length;
      const omitted = file.added + file.removed - file.lines.length;
      if (omitted) file.linesOmitted = omitted;
    }
    files.push(file);
  }
  return { files, ...(filesOmitted ? { filesOmitted } : {}) };
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
    credentialShape(value)
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
  if (id === undefined || mcp || merged.kind !== "edit") state.fileChanges = undefined;
  else if (!state.fileChangesSent && Array.isArray(update.content)) {
    state.fileChanges = fileChanges(update.content, workspace);
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
    ...(!state.fileChangesSent && state.fileChanges !== undefined ? { fileChanges: state.fileChanges } : {}),
  };
  if (state.summary !== undefined) state.summarySent = true;
  if (state.fileChanges !== undefined) {
    state.fileChangesSent = true;
    state.fileChanges = undefined;
  }
  return progress;
}

export interface AcpProgressState {
  tools: Map<string, ToolProgressState>;
  lastPlanFrame?: string;
}

/** Per-turn display deduplication; the caller isolates construction and delivery failures. */
export function agentProgress(
  update: Record<string, unknown>,
  evidence: AcpToolEvidenceAccumulator,
  state: AcpProgressState,
  workspace: string,
): AcpProgressUpdate | null {
  if (update.sessionUpdate !== "plan") return toolCallProgress(update, evidence, state.tools, workspace);
  const progress = planProgress(update);
  if (progress === null) return null;
  const serialized = JSON.stringify(progress);
  if (serialized === state.lastPlanFrame) return null;
  state.lastPlanFrame = serialized;
  return progress;
}
