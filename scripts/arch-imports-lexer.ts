/**
 * Lexer for the arch.imports lane: a tokenizer for comments, strings, template
 * literals, and regex literals (regex vs. division is decided from the previous
 * token); the local-import parser; and the best-effort function-span scan
 * behind the non-failing size report.
 */

// ---- Tokenizer -------------------------------------------------------------

export interface Token {
  kind: "id" | "str" | "num" | "punct" | "tmpl" | "regex";
  value: string;
  line: number;
  closesControlHead?: boolean; // `)` of an if/while/for/with head: regex next
}

const CONTROL_HEADS = new Set(["if", "while", "for", "with"]);

const REGEX_AFTER_KEYWORDS = new Set(
  "return typeof instanceof in of new delete void throw case do else yield await"
    .split(" "),
);

function isIdStart(ch: string): boolean {
  return /[A-Za-z_$]/.test(ch);
}

function isIdPart(ch: string): boolean {
  return /[\w$]/.test(ch);
}

function regexAllowed(prev: Token | undefined): boolean {
  if (prev === undefined) return true;
  if (prev.kind === "id") return REGEX_AFTER_KEYWORDS.has(prev.value);
  if (prev.kind === "punct") {
    if (prev.value === ")") return prev.closesControlHead === true;
    return prev.value !== "]";
  }
  return false;
}

// A quoted string starting at `start`: its value (escapes reduced to the
// escaped character), the index just past it, and escaped newlines inside it.
function scanString(
  source: string,
  start: number,
): { value: string; end: number; newlines: number } {
  const quote = source[start];
  let value = "";
  let newlines = 0;
  let i = start + 1;
  while (i < source.length && source[i] !== quote) {
    if (source[i] === "\\") {
      value += source[i + 1] ?? "";
      if (source[i + 1] === "\n") newlines++;
      i += 2;
      continue;
    }
    if (source[i] === "\n") break;
    value += source[i];
    i++;
  }
  return { value, end: i + 1, newlines };
}

// A regex literal starting at `start`, including flags; returns the index just
// past it. A `/` inside a character class does not end the literal.
function scanRegex(source: string, start: number): number {
  let inClass = false;
  let i = start + 1;
  while (i < source.length) {
    const c = source[i]!;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "\n") break;
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) break;
    i++;
  }
  i++;
  while (i < source.length && isIdPart(source[i]!)) i++;
  return i;
}

/**
 * A lexer that is exact about comments, strings, template literals (including
 * nested `${}` expressions), and regex literals, which is all the import
 * parser and the function-size scan need.
 */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let line = 1;
  let i = 0;
  // Brace depths at which a template literal's `${` expression was opened.
  const templateStack: number[] = [];
  let braceDepth = 0;
  const parenHeads: boolean[] = []; // per open `(`: a control-statement head?

  const scanTemplate = (startLine: number) => {
    // Called with `i` just past the opening backtick or a closing `}`.
    while (i < source.length) {
      const ch = source[i]!;
      if (ch === "\\") {
        if (source[i + 1] === "\n") line++;
        i += 2;
        continue;
      }
      if (ch === "\n") line++;
      if (ch === "`") {
        i++;
        tokens.push({ kind: "tmpl", value: "`", line: startLine });
        return;
      }
      if (ch === "$" && source[i + 1] === "{") {
        i += 2;
        tokens.push({ kind: "tmpl", value: "`", line: startLine });
        templateStack.push(braceDepth);
        braceDepth++;
        return;
      }
      i++;
    }
  };

  while (i < source.length) {
    const ch = source[i]!;
    if (ch === "\n") {
      line++;
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (
        i < source.length && !(source[i] === "*" && source[i + 1] === "/")
      ) {
        if (source[i] === "\n") line++;
        i++;
      }
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const scanned = scanString(source, i);
      tokens.push({ kind: "str", value: scanned.value, line });
      line += scanned.newlines;
      i = scanned.end;
      continue;
    }
    if (ch === "`") {
      i++;
      scanTemplate(line);
      continue;
    }
    if (ch === "/" && regexAllowed(tokens[tokens.length - 1])) {
      tokens.push({ kind: "regex", value: "/", line });
      i = scanRegex(source, i);
      continue;
    }
    if (isIdStart(ch)) {
      const start = i;
      while (i < source.length && isIdPart(source[i]!)) i++;
      tokens.push({ kind: "id", value: source.slice(start, i), line });
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const start = i;
      while (i < source.length && /[\w.]/.test(source[i]!)) i++;
      tokens.push({ kind: "num", value: source.slice(start, i), line });
      continue;
    }
    if (ch === "{") {
      braceDepth++;
      tokens.push({ kind: "punct", value: ch, line });
      i++;
      continue;
    }
    if (ch === "}") {
      braceDepth--;
      if (
        templateStack.length > 0 &&
        templateStack[templateStack.length - 1] === braceDepth
      ) {
        templateStack.pop();
        i++;
        scanTemplate(line);
        continue;
      }
      tokens.push({ kind: "punct", value: ch, line });
      i++;
      continue;
    }
    if (ch === "=" && source[i + 1] === ">") {
      tokens.push({ kind: "punct", value: "=>", line });
      i += 2;
      continue;
    }
    if (
      ch === "?" && source[i + 1] === "." && !/[0-9]/.test(source[i + 2] ?? "")
    ) {
      tokens.push({ kind: "punct", value: "?.", line });
      i += 2;
      continue;
    }
    if (ch === "." && source[i + 1] === "." && source[i + 2] === ".") {
      tokens.push({ kind: "punct", value: "...", line });
      i += 3;
      continue;
    }
    const token: Token = { kind: "punct", value: ch, line };
    if (ch === "(") {
      const head = tokens[tokens.length - 1];
      parenHeads.push(head?.kind === "id" && CONTROL_HEADS.has(head.value));
    } else if (ch === ")" && parenHeads.pop() === true) {
      token.closesControlHead = true;
    }
    tokens.push(token);
    i++;
  }
  return tokens;
}

// ---- Import parsing --------------------------------------------------------

export interface ImportRecord {
  specifier: string | null; // null: a non-literal dynamic import
  kind: "static" | "dynamic";
  typeOnly: boolean;
  line: number;
}

export function isPunct(token: Token | undefined, value: string): boolean {
  return token !== undefined && token.kind === "punct" && token.value === value;
}

export function isId(token: Token | undefined, value: string): boolean {
  return token !== undefined && token.kind === "id" && token.value === value;
}

// An import/export clause holds only names, braces, commas, `*`, `as`, and
// `type`. Returns the index of the `from` keyword, or -1 if this is not a
// `... from "x"` form.
function findFrom(tokens: Token[], start: number): number {
  for (let j = start; j < tokens.length; j++) {
    const t = tokens[j]!;
    if (t.kind === "id") {
      if (t.value === "from" && tokens[j + 1]?.kind === "str") return j;
      continue;
    }
    if (t.kind === "punct" && ["{", "}", ",", "*"].includes(t.value)) continue;
    return -1;
  }
  return -1;
}

// `import type ...`, `export type {...}`, or a braced clause in which every
// element carries its own `type` modifier.
function clauseIsTypeOnly(
  tokens: Token[],
  start: number,
  from: number,
): boolean {
  const first = tokens[start];
  if (
    isId(first, "type") && !isId(tokens[start + 1], "from") &&
    !isPunct(tokens[start + 1], ",")
  ) {
    return true;
  }
  if (!isPunct(first, "{")) return false;
  let elementStart = true;
  let sawElement = false;
  for (let j = start + 1; j < from; j++) {
    const t = tokens[j]!;
    if (isPunct(t, "}")) break;
    if (isPunct(t, ",")) {
      elementStart = true;
      continue;
    }
    if (elementStart) {
      if (
        !isId(t, "type") || isPunct(tokens[j + 1], ",") ||
        isPunct(tokens[j + 1], "}")
      ) {
        return false;
      }
      sawElement = true;
      elementStart = false;
    }
  }
  return sawElement;
}

export function parseImports(source: string): ImportRecord[] {
  const tokens = tokenize(source);
  const records: ImportRecord[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind !== "id" || (t.value !== "import" && t.value !== "export")) {
      continue;
    }
    const prev = tokens[i - 1];
    if (isPunct(prev, ".") || isPunct(prev, "?.")) continue;
    const next = tokens[i + 1];
    if (t.value === "import" && isPunct(next, "(")) {
      const arg = tokens[i + 2];
      const after = tokens[i + 3];
      const literal = arg?.kind === "str" &&
        (isPunct(after, ")") || isPunct(after, ","));
      records.push({
        specifier: literal ? arg!.value : null,
        kind: "dynamic",
        typeOnly: false,
        line: t.line,
      });
      continue;
    }
    if (t.value === "import" && next?.kind === "str") {
      records.push({
        specifier: next.value,
        kind: "static",
        typeOnly: false,
        line: t.line,
      });
      continue;
    }
    if (t.value === "export") {
      const lead = isId(next, "type") ? tokens[i + 2] : next;
      if (!isPunct(lead, "{") && !isPunct(lead, "*")) continue;
    }
    const from = findFrom(tokens, i + 1);
    if (from < 0) continue;
    records.push({
      specifier: tokens[from + 1]!.value,
      kind: "static",
      typeOnly: clauseIsTypeOnly(tokens, i + 1, from),
      line: t.line,
    });
  }
  return records;
}

// ---- Size report -----------------------------------------------------------

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
