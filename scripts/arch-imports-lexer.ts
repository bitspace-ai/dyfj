/**
 * Lexer for the arch.imports lane: a tokenizer for comments, strings, template
 * literals, and regex literals (regex vs. division is decided from the tokens
 * before the `/`), and the local-import parser.
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
    if ((ch === "+" || ch === "-") && source[i + 1] === ch) {
      tokens.push({ kind: "punct", value: ch + ch, line });
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
      token.regexNext = true;
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
      // `type`, `type as X`: a value import of an export named `type`.
      const next = tokens[j + 1];
      const renamedType = isId(next, "as") && tokens[j + 2]?.kind === "id" &&
        (isPunct(tokens[j + 3], ",") || isPunct(tokens[j + 3], "}"));
      if (
        !isId(t, "type") || isPunct(next, ",") || isPunct(next, "}") ||
        renamedType
      ) {
        return false;
      }
      sawElement = true;
      elementStart = false;
    }
  }
  return sawElement;
}

const MEMBER_MODIFIERS = new Set(
  "static async get set public private protected override readonly".split(" "),
);

// An object or class method named `import`, as in `{ import(v) { … } }`: the
// name sits where a member can start, and its parameter list is followed by a
// body or a return type.
function isImportMethod(tokens: Token[], at: number): boolean {
  const prev = tokens[at - 1];
  const memberStart = prev === undefined ||
    (prev.kind === "punct" && ["{", "}", ",", ";", "*"].includes(prev.value)) ||
    (prev.kind === "id" && MEMBER_MODIFIERS.has(prev.value));
  if (!memberStart) return false;
  let depth = 0;
  for (let j = at + 1; j < tokens.length; j++) {
    if (isPunct(tokens[j], "(")) depth++;
    else if (isPunct(tokens[j], ")") && --depth === 0) {
      return isPunct(tokens[j + 1], "{") || isPunct(tokens[j + 1], ":");
    }
  }
  return false;
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
      if (isImportMethod(tokens, i)) continue;
      const arg = tokens[i + 2];
      const after = tokens[i + 3];
      const literal = arg?.kind === "str" &&
        (isPunct(after, ")") || isPunct(after, ","));
      // `typeof import("./x")` is a type query: a type-only static edge.
      const typeQuery = isId(prev, "typeof");
      if (typeQuery && !literal) continue;
      records.push({
        specifier: literal ? arg!.value : null,
        kind: typeQuery ? "static" : "dynamic",
        typeOnly: typeQuery,
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
