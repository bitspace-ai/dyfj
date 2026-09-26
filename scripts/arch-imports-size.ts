/**
 * Size report for the arch.imports lane (non-failing): modules over 600 lines
 * and functions over 150 lines. Function detection is lexical and best-effort:
 * declarations, methods, and arrow functions with a block body.
 */

import { isId, isPunct, type Token, tokenize } from "./arch-imports-lexer.ts";

export const MODULE_LINE_LIMIT = 600;
export const FUNCTION_LINE_LIMIT = 150;

export interface FunctionSpan {
  name: string;
  startLine: number;
  endLine: number;
}

const CONTROL_KEYWORDS = new Set(
  "if for while switch catch with return typeof await new"
    .split(" "),
);

function matchingForward(tokens: Token[], open: number): number {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const close = pairs[tokens[open]!.value]!;
  let depth = 0;
  for (let j = open; j < tokens.length; j++) {
    if (isPunct(tokens[j], tokens[open]!.value)) depth++;
    else if (isPunct(tokens[j], close)) {
      depth--;
      if (depth === 0) return j;
    }
  }
  return tokens.length - 1;
}

function matchingBackward(
  tokens: Token[],
  close: number,
  open: string,
): number {
  const closer = tokens[close]!.value;
  let depth = 0;
  for (let j = close; j >= 0; j--) {
    if (isPunct(tokens[j], closer)) depth++;
    else if (isPunct(tokens[j], open)) {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

// After a parameter list's `)`, skip an optional return type annotation and
// return the index of the body `{`, or -1 when there is no body here.
function bodyAfterParams(tokens: Token[], close: number): number {
  let j = close + 1;
  if (isPunct(tokens[j], "{")) return j;
  if (!isPunct(tokens[j], ":")) return -1;
  j++;
  let typeStart = true;
  while (j < tokens.length) {
    const t = tokens[j]!;
    if (t.kind === "punct") {
      if (t.value === "{") {
        if (typeStart) {
          j = matchingForward(tokens, j) + 1;
          typeStart = false;
          continue;
        }
        return j;
      }
      if (t.value === "(" || t.value === "[") {
        j = matchingForward(tokens, j) + 1;
        typeStart = false;
        continue;
      }
      if (t.value === "<") {
        let depth = 0;
        for (; j < tokens.length; j++) {
          if (isPunct(tokens[j], "<")) depth++;
          else if (isPunct(tokens[j], ">")) {
            depth--;
            if (depth === 0) break;
          }
        }
        j++;
        typeStart = false;
        continue;
      }
      if (["|", "&", ".", "=>", ","].includes(t.value)) {
        typeStart = true;
        j++;
        continue;
      }
      if (t.value === "?" || t.value === ":") {
        typeStart = true;
        j++;
        continue;
      }
      return -1;
    }
    typeStart = false;
    j++;
  }
  return -1;
}

function nameBefore(tokens: Token[], index: number): string {
  // `const name = ...`, `name: ...`, or `name = ...` before an arrow function.
  for (let j = index - 1; j >= Math.max(0, index - 60); j--) {
    const t = tokens[j]!;
    if (isPunct(t, ")")) {
      // A parameter list (and any return type after it) sits between the
      // name and the arrow.
      j = matchingBackward(tokens, j, "(");
      continue;
    }
    if (isPunct(t, ":") && isPunct(tokens[j - 1], ")")) continue;
    if (isPunct(t, "=") || isPunct(t, ":")) {
      const candidate = tokens[j - 1];
      if (candidate?.kind === "id" || candidate?.kind === "str") {
        return candidate.value;
      }
      return "<anonymous>";
    }
    if (isPunct(t, ";") || isPunct(t, "{") || isPunct(t, "}")) break;
  }
  return "<anonymous>";
}

// The first token of an arrow function's parameters: the `(` of a
// parenthesized list (past any return type annotation), or the bare parameter.
function arrowStart(tokens: Token[], arrow: number): number {
  for (let j = arrow - 1; j >= Math.max(0, arrow - 60); j--) {
    const t = tokens[j]!;
    if (isPunct(t, ")")) {
      const open = matchingBackward(tokens, j, "(");
      if (j === arrow - 1 || isPunct(tokens[j + 1], ":")) {
        return Math.max(open, 0);
      }
      j = open;
      continue;
    }
    if (
      isPunct(t, ";") || isPunct(t, "{") || isPunct(t, "}") || isPunct(t, "=")
    ) break;
  }
  return Math.max(arrow - 1, 0);
}

/** Lexical, best-effort function spans: declarations, methods, arrows. */
export function functionSpans(source: string): FunctionSpan[] {
  const tokens = tokenize(source);
  const spans: FunctionSpan[] = [];
  const seenBodies = new Set<number>();
  const push = (name: string, startLine: number, body: number) => {
    if (body < 0 || seenBodies.has(body)) return;
    seenBodies.add(body);
    const end = matchingForward(tokens, body);
    spans.push({ name, startLine, endLine: tokens[end]!.line });
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (isPunct(t, "=>") && isPunct(tokens[i + 1], "{")) {
      const start = arrowStart(tokens, i);
      push(
        nameBefore(tokens, Math.max(start, 0)),
        tokens[Math.max(start, 0)]!.line,
        i + 1,
      );
      continue;
    }
    if (!isPunct(t, "(")) continue;
    let head = i - 1;
    if (isPunct(tokens[head], ">")) {
      let depth = 0;
      for (; head >= 0; head--) {
        if (isPunct(tokens[head], ">")) depth++;
        else if (isPunct(tokens[head], "<")) {
          depth--;
          if (depth === 0) break;
        }
      }
      head--;
    }
    const nameToken = tokens[head];
    if (nameToken === undefined || nameToken.kind !== "id") continue;
    if (CONTROL_KEYWORDS.has(nameToken.value)) continue;
    const isFunctionKeyword = nameToken.value === "function";
    const beforeName = tokens[head - 1];
    const declared = isFunctionKeyword || isId(beforeName, "function") ||
      beforeName === undefined ||
      (beforeName.kind === "punct" &&
        [";", "{", "}", ","].includes(beforeName.value)) ||
      (beforeName.kind === "id" &&
        [
          "async",
          "static",
          "get",
          "set",
          "public",
          "private",
          "protected",
          "readonly",
          "override",
        ]
          .includes(beforeName.value)) ||
      isPunct(beforeName, "*");
    if (!declared) continue;
    const close = matchingForward(tokens, i);
    const body = bodyAfterParams(tokens, close);
    const name = isFunctionKeyword ? nameBefore(tokens, head) : nameToken.value;
    push(name, nameToken.line, body);
  }
  return spans.sort((a, b) => a.startLine - b.startLine);
}

export function countLines(source: string): number {
  if (source === "") return 0;
  const lines = source.split("\n").length;
  return source.endsWith("\n") ? lines - 1 : lines;
}

export interface SizeReport {
  modules: { path: string; lines: number }[];
  functions: { path: string; name: string; line: number; lines: number }[];
}

export function sizeReport(sources: ReadonlyMap<string, string>): SizeReport {
  const modules: SizeReport["modules"] = [];
  const functions: SizeReport["functions"] = [];
  for (const [path, source] of [...sources.entries()].sort()) {
    const lines = countLines(source);
    if (lines > MODULE_LINE_LIMIT) modules.push({ path, lines });
    for (const span of functionSpans(source)) {
      const length = span.endLine - span.startLine + 1;
      if (length > FUNCTION_LINE_LIMIT) {
        functions.push({
          path,
          name: span.name,
          line: span.startLine,
          lines: length,
        });
      }
    }
  }
  modules.sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path));
  functions.sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path));
  return { modules, functions };
}

export function formatSizeReport(report: SizeReport): string[] {
  return [
    ...report.modules.map((m) =>
      `  module over ${MODULE_LINE_LIMIT} lines: ${m.path} (${m.lines})`
    ),
    ...report.functions.map((f) =>
      `  function over ${FUNCTION_LINE_LIMIT} lines: ${f.path}:${f.line} ${f.name} (${f.lines})`
    ),
  ];
}
