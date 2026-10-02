/**
 * `read_file` and `list_files` executors: read-only, auto-approved, scoped to
 * the workspace root. Both return an `error: …` string rather than throwing.
 */

import { clipToUtf8Bytes } from "../../kernel/mod.ts";
import type { WorkspaceRoot } from "./root-anchors.ts";
import {
  containedRealPath,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ENTRIES,
  HARD_MAX_FILE_BYTES,
  readContainedFile,
  resolveWorkspacePath,
  rootStillAnchored,
  safeErrorReason,
  sanitizeOutputText,
} from "./file-access.ts";

/**
 * Read a file's text content, scoped to the workspace root.
 *
 * `range` selects a 1-based inclusive line window, so a large file can be read
 * in pieces without shelling out to sed/head/tail — each of which would route
 * through operator approval. The byte cap still applies to the selected window.
 *
 * `maxBytes` caps the text handed back to the model, in encoded UTF-8 bytes —
 * `.length` would count UTF-16 code units and let a multibyte file return up to
 * three times the named ceiling. It does NOT cap the read itself: the whole
 * file is decoded before a window is sliced out of it. The memory bound is the
 * separate size check against HARD_MAX_FILE_BYTES, which the model cannot
 * raise.
 */
export async function executeReadFile(
  workspace: WorkspaceRoot,
  p: string,
  maxBytes = DEFAULT_MAX_BYTES,
  range: { offset?: number; limit?: number } = {},
): Promise<string> {
  const root = workspace.path;
  const hasRange = range.offset !== undefined || range.limit !== undefined;
  const offset = range.offset ?? 1;
  if (hasRange && (!Number.isInteger(offset) || offset < 1)) {
    return `error: offset must be an integer >= 1`;
  }
  if (
    range.limit !== undefined &&
    (!Number.isInteger(range.limit) || range.limit < 1)
  ) {
    return `error: limit must be an integer >= 1`;
  }
  let abs: string;
  try {
    abs = resolveWorkspacePath(root, p);
  } catch (err) {
    // resolveWorkspacePath's message carries only the caller-supplied path.
    return `error: ${(err as Error).message}`;
  }
  try {
    const target = await containedRealPath(workspace, abs);
    if (target === null) {
      return `error: path escapes the workspace root: ${sanitizeOutputText(p)}`;
    }
    const info = await Deno.stat(target);
    if (info.isDirectory) {
      return `error: ${sanitizeOutputText(p)} is a directory; use list_files`;
    }
    const rootReal = await workspace.verify();
    const read = await readContainedFile(target, HARD_MAX_FILE_BYTES, rootReal);
    if (!read.ok) {
      return `error: cannot read ${sanitizeOutputText(p)}: ${read.reason}`;
    }
    // Exit verification sits HERE — after the filesystem work, before anything
    // content-derived can be returned. The past-end error below embeds a line
    // count; placing the check any later would let an unverified root leak
    // that much.
    {
      const rootLost = await rootStillAnchored(workspace);
      if (rootLost !== null) return rootLost;
    }
    const full = new TextDecoder("utf-8", { fatal: false }).decode(read.bytes);
    let text = full;
    if (hasRange) {
      const window = lineWindow(full, offset, range.limit);
      if (window === null) {
        return `error: offset ${offset} is past end of ${
          sanitizeOutputText(p)
        } (${countLines(full)} lines)`;
      }
      text = window.text;
      const more = window.totalLines - window.endLine;
      if (more > 0) {
        text =
          `${text}\n\n[lines ${offset}-${window.endLine} of ${window.totalLines}; ${more} more]`;
      }
    }
    const clipped = clipToUtf8Bytes(text, maxBytes);
    if (clipped !== null) {
      return `${clipped}\n\n[truncated at ${maxBytes} bytes]`;
    }
    return text;
  } catch (err) {
    const rootLost = await rootStillAnchored(workspace);
    if (rootLost !== null) return rootLost;
    return `error: cannot read ${sanitizeOutputText(p)}: ${
      safeErrorReason(err)
    }`;
  }
}

/** Total lines, counted the way `split("\n")` would, without allocating them. */
function countLines(text: string): number {
  let lines = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
    lines++;
  }
  return lines;
}

/**
 * A window of `limit` lines starting at 1-based line `offset` — lines `offset`
 * through `offset + limit - 1` inclusive — as ONE slice of the original
 * string, plus the totals the caller reports. Null when `offset` is past the
 * end; an omitted `limit` means "to the end of the file".
 *
 * Deliberately not `split("\n").slice(...)`: a 4 MiB file of newlines splits
 * into four million strings, and doing that to hand back twenty lines is a
 * large transient allocation on a tool nothing prompts for. One pass over the
 * text finds the window's bounds and counts the rest, so cost tracks file size
 * rather than line count.
 */
function lineWindow(
  text: string,
  offset: number,
  limit: number | undefined,
): { text: string; totalLines: number; endLine: number } | null {
  const lastWanted = limit === undefined
    ? Number.POSITIVE_INFINITY
    : offset + limit - 1;
  let totalLines = 0;
  let startIndex = -1;
  let endIndex = -1;
  let endLine = 0;
  let pos = 0;
  while (pos <= text.length) {
    totalLines++;
    if (totalLines === offset) startIndex = pos;
    const nl = text.indexOf("\n", pos);
    const lineEnd = nl === -1 ? text.length : nl;
    if (totalLines === lastWanted) {
      endIndex = lineEnd;
      endLine = totalLines;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (startIndex === -1) return null; // offset past end
  if (endIndex === -1) {
    endIndex = text.length;
    endLine = totalLines;
  }
  return { text: text.slice(startIndex, endIndex), totalLines, endLine };
}

/** List directory entries (one per line; directories suffixed with /). */
export async function executeListFiles(
  workspace: WorkspaceRoot,
  p = ".",
  maxEntries = DEFAULT_MAX_ENTRIES,
): Promise<string> {
  const root = workspace.path;
  let abs: string;
  try {
    abs = resolveWorkspacePath(root, p);
  } catch (err) {
    // resolveWorkspacePath's message carries only the caller-supplied path.
    return `error: ${(err as Error).message}`;
  }
  try {
    const target = await containedRealPath(workspace, abs);
    if (target === null) {
      return `error: path escapes the workspace root: ${sanitizeOutputText(p)}`;
    }
    const entries: string[] = [];
    for await (const entry of Deno.readDir(target)) {
      entries.push(entry.isDirectory ? `${entry.name}/` : entry.name);
    }
    const rootLost = await rootStillAnchored(workspace);
    if (rootLost !== null) return rootLost;
    if (entries.length === 0) return "(empty directory)";
    entries.sort();
    if (entries.length > maxEntries) {
      const shown = entries.slice(0, maxEntries);
      return `${shown.join("\n")}\n[${
        entries.length - maxEntries
      } more entries omitted]`;
    }
    return entries.join("\n");
  } catch (err) {
    const rootLost = await rootStillAnchored(workspace);
    if (rootLost !== null) return rootLost;
    return `error: cannot list ${sanitizeOutputText(p)}: ${
      safeErrorReason(err)
    }`;
  }
}
