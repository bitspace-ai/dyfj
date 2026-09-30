/**
 * Size checks for the arch.imports lane (specs/prd/PRD-11 R2).
 *
 * - The report (non-failing) lists modules over the 600-line target and
 *   functions over the 150-line target.
 * - The hard limits fail the lane: a runtime module over 1,000 lines or a
 *   function in one over 200 lines, unless `scripts/arch-size-exceptions.json`
 *   names it with its reason. An entry records the size it may not exceed, so
 *   an excepted module or function can shrink but not grow, and an entry for
 *   something back under its limit fails the lane until it is removed.
 *
 * Function detection is lexical and best-effort: declarations, methods, and
 * arrow functions with a block body. It uses its own small tokenizer, which has
 * the usual hand-lexer limits (regex vs. division is decided from the
 * preceding tokens); a misread only shifts a reported span. The import graph
 * does not use it.
 */

// ---- Tokenizer -------------------------------------------------------------

export interface Token {
  kind: "id" | "str" | "num" | "punct" | "tmpl" | "regex";
  value: string;
  line: number;
  // On `)` and `}`: whether a `/` after it starts a regex. True for the `)` of
  // an if/while/for/with head and the `}` of a block, false otherwise.
  regexNext?: boolean;
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

// Tokens after which a `{` opens an object literal rather than a block.
const OBJECT_AFTER = new Set("( [ , = : ? ! & | + - * % < > ~ ^".split(" "));

// Whether a `{` after `head` opens a block (as opposed to an object literal).
function opensBlock(head: Token | undefined): boolean {
  if (head?.kind === "punct") return !OBJECT_AFTER.has(head.value);
  if (head?.kind === "id" && (head.value === "else" || head.value === "do")) {
    return true;
  }
  return !(head?.kind === "id" && REGEX_AFTER_KEYWORDS.has(head.value));
}

function regexAllowed(tokens: readonly Token[]): boolean {
  const prev = tokens[tokens.length - 1];
  if (prev === undefined) return true;
  if (prev.kind === "id") return REGEX_AFTER_KEYWORDS.has(prev.value);
  if (prev.kind !== "punct" || prev.value === "]") return false;
  if (prev.value === ")" || prev.value === "}") return prev.regexNext === true;
  // A postfix `++`/`--` ends an expression, so the `/` is a division.
  const before = tokens[tokens.length - 2];
  const postfix = (prev.value === "++" || prev.value === "--") &&
    before !== undefined &&
    (before.kind === "id" || before.kind === "num" || before.value === ")" ||
      before.value === "]");
  return !postfix;
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
// Multi-character punctuators the span scan and regex detection rely on.
const MULTI_PUNCT = ["...", "=>", "?.", "++", "--"];

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let line = 1;
  let i = 0;
  // Brace depths at which a template literal's `${` expression was opened.
  const templateStack: number[] = [];
  let braceDepth = 0;
  const parenHeads: boolean[] = []; // per open `(`: a control-statement head?
  const braceBlocks: boolean[] = []; // per open `{`: a block, not an object?

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
    if (ch === "/" && regexAllowed(tokens)) {
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
      braceBlocks.push(opensBlock(tokens[tokens.length - 1]));
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
      tokens.push({
        kind: "punct",
        value: ch,
        line,
        regexNext: braceBlocks.pop(),
      });
      i++;
      continue;
    }
    const multi = MULTI_PUNCT.find((p) =>
      source.startsWith(p, i) &&
      !(p === "?." && /[0-9]/.test(source[i + 2] ?? "")) // `a?.5:b` ternary
    );
    if (multi !== undefined) {
      tokens.push({ kind: "punct", value: multi, line });
      i += multi.length;
      continue;
    }
    const token: Token = { kind: "punct", value: ch, line };
    if (ch === "(") {
      const head = tokens[tokens.length - 1];
      parenHeads.push(head?.kind === "id" && CONTROL_HEADS.has(head.value));
    } else if (ch === ")" && parenHeads.pop() === true) {
      token.regexNext = true;
    }
    tokens.push(token);
    i++;
  }
  return tokens;
}

function isPunct(token: Token | undefined, value: string): boolean {
  return token !== undefined && token.kind === "punct" && token.value === value;
}

function isId(token: Token | undefined, value: string): boolean {
  return token !== undefined && token.kind === "id" && token.value === value;
}

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

export const MODULE_HARD_LIMIT = 1000;
export const FUNCTION_HARD_LIMIT = 200;

/** One entry of `scripts/arch-size-exceptions.json`. */
export interface SizeException {
  kind: "module" | "function";
  path: string;
  /** The function's reported name; functions only. */
  name?: string;
  /** The recorded size, which the module or function may not exceed. */
  lines: number;
  reason: string;
}

function exceptionKey(kind: string, path: string, name?: string): string {
  return kind === "module" ? `module ${path}` : `function ${path} ${name}`;
}

/**
 * Hard-limit violations over the runtime modules `isRuntime` selects: each
 * module or function over its limit without an exception, each excepted one
 * that grew past its recorded size, and each exception that no longer
 * matches anything over its limit. Malformed entries are violations too.
 */
export function hardLimitViolations(
  sources: ReadonlyMap<string, string>,
  isRuntime: (path: string) => boolean,
  exceptions: readonly SizeException[],
): string[] {
  const errors: string[] = [];
  const byKey = new Map<string, SizeException>();
  for (const entry of exceptions) {
    const key = exceptionKey(entry.kind, entry.path, entry.name);
    const wellFormed = (entry.kind === "module" && entry.name === undefined) ||
      (entry.kind === "function" && typeof entry.name === "string" &&
        entry.name !== "");
    if (
      !wellFormed || !Number.isSafeInteger(entry.lines) ||
      typeof entry.reason !== "string" || entry.reason.trim() === ""
    ) {
      errors.push(`size exception is malformed: ${key}`);
      continue;
    }
    if (byKey.has(key)) {
      errors.push(`size exception is listed twice: ${key}`);
      continue;
    }
    byKey.set(key, entry);
  }
  const used = new Set<string>();
  const check = (key: string, label: string, lines: number, limit: number) => {
    if (lines <= limit) return;
    const entry = byKey.get(key);
    if (entry === undefined) {
      errors.push(
        `${label} is over the ${limit}-line limit (${lines}); split it, or ` +
          "add a size exception with its reason",
      );
      return;
    }
    used.add(key);
    if (lines > entry.lines) {
      errors.push(
        `${label} grew past its recorded size (${lines} > ${entry.lines}); ` +
          "an excepted size may only shrink",
      );
    }
  };
  for (const [path, source] of [...sources.entries()].sort()) {
    if (!isRuntime(path)) continue;
    check(
      exceptionKey("module", path),
      `module ${path}`,
      countLines(source),
      MODULE_HARD_LIMIT,
    );
    for (const span of functionSpans(source)) {
      check(
        exceptionKey("function", path, span.name),
        `function ${path}:${span.startLine} ${span.name}`,
        span.endLine - span.startLine + 1,
        FUNCTION_HARD_LIMIT,
      );
    }
  }
  for (const [key] of byKey) {
    if (!used.has(key)) {
      errors.push(
        `size exception no longer matches anything over its limit; remove it: ${key}`,
      );
    }
  }
  return errors;
}
