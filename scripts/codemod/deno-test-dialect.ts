// Test-dialect codemod (BIT-615): phase S2a of decision D32.
//
// Rewrites what runs *inside* test registrations onto node: builtins:
// `@std/assert` -> `node:assert/strict`, `@std/testing/mock` -> the `mock`
// of `node:test`, and test-side calls on the host runtime's global object
// (files, environment, process, error classes) -> `node:fs`, `node:os`,
// `node:path` and `node:process`. Registrations (the host's test function,
// `@std/testing/bdd`, `t.step`) stay as they are; they move with the runner in
// S2b. Whatever a rule cannot convert safely is left in place and reported,
// as a hand-review flag or as an unconverted occurrence.
//
// Text and token rules only, no parser dependency: a small scanner tells code
// from strings, comments and regex literals, and the rules match calls in the
// code. Every rule is idempotent. Delete this tool once S2 is done.
//
// Like the runtime.neutral lane, this file is written to node: builtins and
// never names the host runtime's global in its own text.
//
// Usage (from the repository root):
//   deno run --allow-read=. --allow-write=. scripts/codemod/deno-test-dialect.ts \
//     [--write] [--json] <file-or-directory>...
// Without --write it is a dry run. A directory is searched for *.test.ts.
// Findings name lines in the file as it is on disk: the original text in a
// dry run, the converted text after --write.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HOST = ["De", "no"].join("");

// ---------------------------------------------------------------- tables --

export interface RuleInfo {
  id: string;
  from: string;
  to: string;
}

/** Every rewrite the tool makes, by rule id. Each id has a fixture. */
export const RULES: readonly RuleInfo[] = [
  {
    id: "assert.import",
    from: "@std/assert",
    to: 'import assert from "node:assert/strict"',
  },
  { id: "assert.ok", from: "assert(x)", to: "assert.ok(x)" },
  {
    id: "assert.equals",
    from: "assertEquals",
    to: "assert.deepStrictEqual",
  },
  {
    id: "assert.strict-equals",
    from: "assertStrictEquals",
    to: "assert.strictEqual",
  },
  {
    id: "assert.not-strict-equals",
    from: "assertNotStrictEquals",
    to: "assert.notStrictEqual",
  },
  { id: "assert.false", from: "assertFalse(x)", to: "assert.ok(!x)" },
  { id: "assert.match", from: "assertMatch", to: "assert.match" },
  { id: "assert.not-match", from: "assertNotMatch", to: "assert.doesNotMatch" },
  {
    id: "assert.string-includes",
    from: "assertStringIncludes(s, t)",
    to: "assert.ok(s.includes(t), message naming both)",
  },
  {
    id: "assert.throws",
    from: "assertThrows(fn, Class?, includes?)",
    to: "assert.throws(fn, Class | validation function)",
  },
  {
    id: "assert.rejects",
    from: "assertRejects(fn, Class?, includes?)",
    to: "assert.rejects(fn, Class | validation function)",
  },
  {
    id: "assert.object-match",
    from: "assertObjectMatch",
    to: "assert.partialDeepStrictEqual",
  },
  { id: "assert.fail", from: "fail", to: "assert.fail" },
  {
    id: "assert.instance-of",
    from: "assertInstanceOf(x, Class)",
    to: "assert.ok(x instanceof Class)",
  },
  {
    id: "assert.array-includes",
    from: "assertArrayIncludes(actual, [a, b])",
    to:
      "assert.deepStrictEqual([a, b].filter((item) => !actual.includes(item)), []), " +
      "or isDeepStrictEqual for items that are not primitive literals",
  },
  {
    id: "assert.compare",
    from:
      "assertLess / assertLessOrEqual / assertGreater / assertGreaterOrEqual",
    to: "assert.ok(a < b) / <= / > / >=, with a message naming both",
  },
  {
    id: "mock.import",
    from: "@std/testing/mock",
    to: 'import { mock } from "node:test"',
  },
  {
    id: "mock.spy",
    from: "spy(fn?) / spy(obj, m)",
    to: "mock.fn(fn?) / mock.method(obj, m)",
  },
  {
    id: "mock.stub",
    from: "stub(obj, m, impl?)",
    to: "mock.method(obj, m, impl ?? () => {})",
  },
  { id: "mock.restore", from: "s.restore()", to: "s.mock.restore()" },
  {
    id: "mock.calls",
    from: "s.calls.length / s.calls[i].args / .returned",
    to: "s.mock.callCount() / s.mock.calls[i].arguments / .result",
  },
  {
    id: "mock.assert-spy-calls",
    from: "assertSpyCalls(s, n)",
    to: "assert.equal(s.mock.callCount(), n)",
  },
  {
    id: "mock.assert-spy-call",
    from: "assertSpyCall(s, i, { args, returned })",
    to: "assertions on s.mock.calls[i].arguments / .result",
  },
  {
    id: "fs.make-temp-dir",
    from: `${HOST}.makeTempDir{,Sync}({ prefix?, dir? })`,
    to: "mkdtemp{,Sync}(join(dir ?? tmpdir(), prefix))",
  },
  {
    id: "fs.remove",
    from: `${HOST}.remove{,Sync}`,
    to: "rm{,Sync}",
  },
  { id: "fs.mkdir", from: `${HOST}.mkdir{,Sync}`, to: "mkdir{,Sync}" },
  {
    id: "fs.read-text-file",
    from: `${HOST}.readTextFile{,Sync}(p)`,
    to: 'readFile{,Sync}(p, "utf8")',
  },
  {
    id: "fs.write-text-file",
    from: `${HOST}.writeTextFile{,Sync}(p, d, { append?, mode? })`,
    to: "writeFile{,Sync} / appendFile{,Sync}",
  },
  {
    id: "fs.stat",
    from: `${HOST}.{stat,lstat}{,Sync}(p).isFile`,
    to: "{stat,lstat}{,Sync}(p).isFile()",
  },
  {
    id: "fs.real-path",
    from: `${HOST}.realPath{,Sync}`,
    to: "realpath{,Sync}",
  },
  { id: "fs.chmod", from: `${HOST}.chmod{,Sync}`, to: "chmod{,Sync}" },
  { id: "fs.rename", from: `${HOST}.rename{,Sync}`, to: "rename{,Sync}" },
  {
    id: "fs.symlink",
    from: `${HOST}.symlink{,Sync}(t, p, { type? })`,
    to: "symlink{,Sync}(t, p, type?)",
  },
  {
    id: "fs.read-dir",
    from: `for (const e of ${HOST}.readDir{,Sync}(p))`,
    to: "for (const e of readdir{,Sync}(p, { withFileTypes: true }))",
  },
  {
    id: "errors.code",
    from: `${HOST}.errors.NotFound / AlreadyExists`,
    to: 'code === "ENOENT" / "EEXIST"',
  },
  {
    id: "errors.not-capable",
    from: `${HOST}.errors.NotCapable`,
    to: 'name === "NotCapable" (a host permission error; S3 removes it)',
  },
  { id: "process.cwd", from: `${HOST}.cwd()`, to: "process.cwd()" },
  {
    id: "process.env",
    from: `${HOST}.env.{get,set,delete,has}`,
    to: "process.env",
  },
  {
    id: "process.exec-path",
    from: `${HOST}.execPath()`,
    to: "process.execPath",
  },
  {
    id: "process.platform",
    from: `${HOST}.build.os`,
    to: 'process.platform ("windows" -> "win32")',
  },
  { id: "process.pid", from: `${HOST}.pid`, to: "process.pid" },
];

/** Hand-review flags: constructs the tool never rewrites. */
export const FLAGS = {
  "error-equality":
    "assertEquals on an Error: deepStrictEqual treats errors with the same " +
    "message as equal; compare name, message and cause explicitly",
  "thrown-value-used":
    "the thrown error is used, but node's assertion returns nothing; " +
    "capture it in a validation function",
  "using-mock":
    "a mock held by `using` restores itself at scope exit; node's does not, " +
    "so restore it in a finally",
  "fake-time": "FakeTime moves to mock.timers by hand",
  "test-permissions":
    "a per-test permissions option (or a read of a permissions structure); " +
    "move the grant to the lane or drop it with a reason",
  "sanitizer-options":
    "a sanitizer option belongs to the registration; it is reviewed with S2b",
  exit: "the test exits the process",
  "permissions-api":
    "the permissions API belongs to the registration and the lane; " +
    "it stays in S2a",
  command:
    "a child process: move to node:child_process by hand (a spawn failure " +
    "arrives as an error event)",
} as const;

export type Flag = keyof typeof FLAGS;

export interface Finding {
  kind: "hand-review" | "unconverted" | "mention";
  flag?: Flag;
  /** 1-based line in the converted text. */
  line: number;
  /** 1-based line in the text before conversion. */
  originalLine: number;
  message: string;
}

export interface ConversionResult {
  source: string;
  rewrites: Map<string, number>;
  findings: Finding[];
}

// ---------------------------------------------------------------- scanner --

const IDENT = /[\w$]/;
const SPACE = /\s/;
const REGEX_AFTER_WORD = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "await",
  "yield",
  // Statement terminators: under ASI a regex can start the next line.
  "break",
  "continue",
  "debugger",
]);

const CONTROL_KEYWORDS = new Set(["if", "while", "for", "with"]);

/**
 * Whether a `/` after the code character at `prev` opens a regex. `mask` is
 * the scan so far: every position before the slash is already classified,
 * so look-behinds skip comments through it.
 */
function regexAllowed(
  text: string,
  prev: number,
  openerOf: Map<number, number>,
  mask: Uint8Array,
): boolean {
  if (prev < 0) return true;
  const c = text[prev];
  // After a `}` a `/` is read as a regex when one parses there: a block
  // closes before a statement, while dividing an object literal is never
  // meaningful. (If no regex parses, the scanner falls back to division.)
  if (c === "}") return true;
  // A postfix ++ or -- ends an operand, so a `/` after it divides.
  if ((c === "+" || c === "-") && text[prev - 1] === c) {
    const operand = text[prevNonSpace(text, prev - 1, mask)];
    if (operand !== undefined && /[\w$)\]]/.test(operand)) return false;
  }
  // After the parenthesis that closes `if (...)` and the like, a statement
  // starts, so `/` opens a regex; after any other `)` it divides.
  if (c === ")") {
    const opener = openerOf.get(prev);
    if (opener === undefined) return false;
    const before = wordBefore(text, opener, mask);
    if (CONTROL_KEYWORDS.has(before.word)) return true;
    // `for await (...)`, unlike `await (expr)`, is a loop header.
    return before.word === "await" &&
      wordBefore(text, before.start, mask).word === "for";
  }
  if (IDENT.test(c)) {
    let start = prev;
    while (start > 0 && IDENT.test(text[start - 1])) start--;
    return REGEX_AFTER_WORD.has(text.slice(start, prev + 1));
  }
  return !")]}\"'`".includes(c);
}

function skipQuoted(text: string, at: number): number {
  const quote = text[at];
  for (let j = at + 1; j < text.length; j++) {
    if (text[j] === "\\") j++;
    else if (text[j] === quote) return j + 1;
    else if (text[j] === "\n") return j;
  }
  return text.length;
}

/** Index after a regex literal starting at `at`, or -1 if it is not one. */
function skipRegex(text: string, at: number): number {
  let inClass = false;
  for (let j = at + 1; j < text.length; j++) {
    const c = text[j];
    if (c === "\\") j++;
    else if (c === "\n") return -1;
    else if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) {
      let end = j + 1;
      while (end < text.length && /[a-z]/.test(text[end])) end++;
      return end;
    }
  }
  return -1;
}

const COMMENT = 2;

/**
 * Marks each character that is code with 1: outside strings, template text,
 * comments and regex literals (template substitutions are code). Comment
 * characters are marked COMMENT, everything else 0.
 */
export function codeMask(
  text: string,
  ambiguous: [start: number, end: number][] = [],
): Uint8Array {
  const mask = new Uint8Array(text.length);
  const templateDepths: number[] = [];
  const openParens: number[] = [];
  const openerOf = new Map<number, number>();
  let depth = 0;
  let prev = -1;
  const templateText = (from: number): number => {
    for (let j = from; j < text.length; j++) {
      if (text[j] === "\\") j++;
      else if (text[j] === "`") return j + 1;
      else if (text[j] === "$" && text[j + 1] === "{") {
        depth++;
        templateDepths.push(depth);
        return j + 2;
      }
    }
    return text.length;
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      const stop = end < 0 ? text.length : end;
      mask.fill(COMMENT, i, stop);
      i = stop;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      mask.fill(COMMENT, i, stop);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipQuoted(text, i);
      prev = i - 1;
      continue;
    }
    if (c === "`") {
      i = templateText(i + 1);
      prev = i - 1;
      continue;
    }
    if (c === "/" && regexAllowed(text, prev, openerOf, mask)) {
      const end = skipRegex(text, i);
      if (end > 0) {
        // After a `}`, on the same line or the next (division continues
        // across a line break), an object literal could stand there and
        // make this division: the reading is reported.
        if (text[prev] === "}") ambiguous.push([i, end]);
        i = end;
        prev = i - 1;
        continue;
      }
    }
    if (c === "(") openParens.push(i);
    else if (c === ")") {
      const opener = openParens.pop();
      if (opener !== undefined) openerOf.set(i, opener);
    }
    if (c === "{") depth++;
    else if (c === "}") {
      if (templateDepths.at(-1) === depth) {
        templateDepths.pop();
        depth--;
        i = templateText(i + 1);
        prev = i - 1;
        continue;
      }
      depth--;
    }
    mask[i] = 1;
    if (!SPACE.test(c)) prev = i;
    i++;
  }
  return mask;
}

class Source {
  readonly mask: Uint8Array;
  /** Regexes read after a same-line `}`, where division was also possible. */
  readonly ambiguous: [start: number, end: number][] = [];
  constructor(readonly text: string) {
    this.mask = codeMask(text, this.ambiguous);
  }
  isCode(i: number): boolean {
    return this.mask[i] === 1;
  }
}

/** The previous character that is neither space nor (given a mask) comment. */
function prevNonSpace(text: string, pos: number, mask?: Uint8Array): number {
  let j = pos - 1;
  while (j >= 0 && (SPACE.test(text[j]) || mask?.[j] === COMMENT)) j--;
  return j;
}

/** The next position that is neither space nor comment, using `src`'s mask. */
function nextCode(src: Source, pos: number): number {
  let j = pos;
  while (
    j < src.text.length &&
    (SPACE.test(src.text[j]) || src.mask[j] === COMMENT)
  ) {
    j++;
  }
  return j;
}

function nextNonSpace(text: string, pos: number): number {
  let j = pos;
  while (j < text.length && SPACE.test(text[j])) j++;
  return j;
}

/** The identifier ending at or before `pos` (skipping spaces), if any. */
function wordBefore(
  text: string,
  pos: number,
  mask?: Uint8Array,
): { start: number; word: string } {
  const end = prevNonSpace(text, pos, mask);
  let start = end;
  while (start >= 0 && IDENT.test(text[start])) start--;
  return { start: start + 1, word: text.slice(start + 1, end + 1) };
}

/**
 * The text of the current statement up to `pos`: from just after the last
 * `;`, `{` or `}` before it, so a binding split over lines is still seen.
 */
function statementHead(text: string, pos: number): string {
  const start = Math.max(
    text.lastIndexOf(";", pos - 1),
    text.lastIndexOf("{", pos - 1),
    text.lastIndexOf("}", pos - 1),
  ) + 1;
  return text.slice(start, pos);
}

function lineStart(text: string, pos: number): number {
  return text.lastIndexOf("\n", pos - 1) + 1;
}

function lineOf(text: string, pos: number): number {
  let line = 1;
  for (
    let i = text.indexOf("\n");
    i >= 0 && i < pos;
    i = text.indexOf("\n", i + 1)
  ) {
    line++;
  }
  return line;
}

function indentAt(text: string, pos: number): string {
  return /^[ \t]*/.exec(text.slice(lineStart(text, pos)))![0];
}

/** Whether the identifier at `pos` is reached through a member access. */
function isMember(src: Source, pos: number): boolean {
  const p = prevNonSpace(src.text, pos, src.mask);
  return p >= 0 && src.text[p] === "." && src.text[p - 1] !== ".";
}

/** Code positions of the identifier `name`, member accesses excluded. */
function occurrences(src: Source, name: string): number[] {
  const found: number[] = [];
  for (
    let i = src.text.indexOf(name);
    i >= 0;
    i = src.text.indexOf(name, i + 1)
  ) {
    if (!src.isCode(i)) continue;
    // A private name (`#name`) is its own identifier, not this one.
    if (i > 0 && (IDENT.test(src.text[i - 1]) || src.text[i - 1] === "#")) {
      continue;
    }
    const after = src.text[i + name.length];
    if (after !== undefined && IDENT.test(after)) continue;
    if (isMember(src, i)) continue;
    found.push(i);
  }
  return found;
}

/** Index of the bracket closing the one at `open`, or -1. */
function matchBracket(src: Source, open: number): number {
  let depth = 0;
  for (let j = open; j < src.text.length; j++) {
    if (!src.isCode(j)) continue;
    const c = src.text[j];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

interface Arg {
  start: number;
  end: number;
  text: string;
}

interface Call {
  start: number;
  calleeEnd: number;
  open: number;
  close: number;
  end: number;
  args: Arg[];
  typeArgs: boolean;
}

function splitList(src: Source, open: number, close: number): Arg[] {
  const args: Arg[] = [];
  let depth = 0;
  let from = open + 1;
  const push = (to: number) => {
    let start = from;
    let end = to;
    while (start < end && SPACE.test(src.text[start])) start++;
    while (end > start && SPACE.test(src.text[end - 1])) end--;
    args.push({ start, end, text: src.text.slice(start, end) });
  };
  for (let j = open + 1; j < close; j++) {
    if (!src.isCode(j)) continue;
    const c = src.text[j];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) {
      push(j);
      from = j + 1;
    }
  }
  push(close);
  if (args.at(-1)!.text === "") args.pop();
  return args;
}

/** The call whose callee spans [start, calleeEnd), if one follows. */
function callAt(
  src: Source,
  start: number,
  calleeEnd: number,
): Call | undefined {
  let j = nextNonSpace(src.text, calleeEnd);
  let typeArgs = false;
  if (src.text[j] === "<") {
    let depth = 0;
    for (; j < src.text.length; j++) {
      const c = src.text[j];
      if (c === "<") depth++;
      else if (c === ">" && src.text[j - 1] !== "=") {
        depth--;
        if (depth === 0) break;
      } else if (c === ";" || c === "\n") return undefined;
    }
    typeArgs = true;
    j = nextNonSpace(src.text, j + 1);
  }
  if (src.text[j] !== "(" || !src.isCode(j)) return undefined;
  const close = matchBracket(src, j);
  if (close < 0) return undefined;
  return {
    start,
    calleeEnd,
    open: j,
    close,
    end: close + 1,
    args: splitList(src, j, close),
    typeArgs,
  };
}

/** Object-literal properties as key -> value text, or undefined. */
function objectProps(text: string): Map<string, string> | undefined {
  const src = new Source(text);
  if (text[0] !== "{" || matchBracket(src, 0) !== text.length - 1) {
    return undefined;
  }
  const props = new Map<string, string>();
  for (const part of splitList(src, 0, text.length - 1)) {
    const m = /^([\w$]+)\s*(?::\s*([\s\S]+))?$/.exec(part.text);
    if (!m) return undefined;
    props.set(m[1], m[2] ?? m[1]);
  }
  return props;
}

/** Whether a unary operator can be prefixed to `text` without parentheses. */
function isPostfixChain(text: string): boolean {
  const src = new Source(text);
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (!src.isCode(i)) continue;
    const c = text[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (depth === 0 && !/[\w$.?!]/.test(c)) return false;
    // `?` only as optional chaining; `??` and a ternary bind looser.
    else if (depth === 0 && c === "?" && text[i + 1] !== ".") return false;
  }
  return text !== "";
}

/**
 * A bare identifier: the only operand an assertion message may read a second
 * time, since a member read can run a getter.
 */
function isBareName(text: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(text);
}

/** `text` as an operand of a binary or relational operator. */
function operand(text: string): string {
  return isPostfixChain(text) || /^-?[\d.][\w.]*$/.test(text)
    ? text
    : `(${text})`;
}

function templateEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(
    /\$\{/g,
    "\\${",
  );
}

function isStatementStart(src: Source, pos: number): boolean {
  const p = prevNonSpace(src.text, pos, src.mask);
  return p < 0 || ";{}".includes(src.text[p]);
}

function isStatementEnd(text: string, end: number): boolean {
  return text[nextNonSpace(text, end)] === ";";
}

// ---------------------------------------------------------------- imports --

interface Named {
  imported: string;
  local: string;
  type: boolean;
}

interface ImportDecl {
  start: number;
  end: number;
  typeOnly: boolean;
  defaultName?: string;
  namespace?: string;
  named?: Named[];
  spec: string;
  /** The named list holds comments, which a rewrite would drop. */
  hasComments?: boolean;
}

const IMPORT =
  /\bimport\s+(type\s+)?([^;'"]*?)\s*from\s*(["'])([^"']+)\3[ \t]*;?/g;

/**
 * `src`'s text with comments blanked to spaces (same length, so positions
 * hold), so a quote, `;` or `:` inside one is not taken for syntax.
 */
function blankComments(src: Source): string {
  return src.text.split("").map((ch, i) =>
    src.mask[i] === COMMENT && ch !== "\n" ? " " : ch
  ).join("");
}

function parseImports(src: Source): ImportDecl[] {
  const decls: ImportDecl[] = [];
  for (const m of blankComments(src).matchAll(IMPORT)) {
    const start = m.index!;
    if (!src.isCode(start) || !isStatementStart(src, start)) continue;
    let clause = m[2].trim();
    const decl: ImportDecl = {
      start,
      end: start + m[0].length,
      typeOnly: m[1] !== undefined,
      spec: m[4],
    };
    const def = /^([\w$]+)\s*(?:,\s*|$)/.exec(clause);
    if (def && def[1] !== "type") {
      decl.defaultName = def[1];
      clause = clause.slice(def[0].length);
    }
    const ns = /^\*\s*as\s+([\w$]+)$/.exec(clause);
    if (ns) decl.namespace = ns[1];
    const braces = /^\{([\s\S]*)\}$/.exec(clause);
    if (braces) {
      decl.named = [];
      if (src.mask.subarray(start, decl.end).includes(COMMENT)) {
        decl.hasComments = true;
      }
      for (const raw of braces[1].split(",")) {
        const part = raw.trim();
        if (part === "") continue;
        const n = /^(type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(part);
        if (!n) continue;
        decl.named.push({
          imported: n[2],
          local: n[3] ?? n[2],
          type: n[1] !== undefined,
        });
      }
    }
    decls.push(decl);
  }
  return decls;
}

const STD_ASSERT = /^(?:jsr:)?@std\/assert(?:@[^/]+)?(?:\/[\w-]+)?$/;
const STD_MOCK = /^(?:jsr:)?@std\/testing(?:@[^/]+)?\/mock$/;
const STD_TIME = /^(?:jsr:)?@std\/testing(?:@[^/]+)?\/time$/;
const STD_PATH = /^(?:jsr:)?@std\/path(?:@[^/]+)?(?:\/[\w-]+)?$/;

function renderImport(
  spec: string,
  defaultName: string | undefined,
  named: Named[],
  typeOnly = false,
): string {
  const parts: string[] = [];
  if (defaultName !== undefined) parts.push(defaultName);
  if (named.length > 0) {
    const names = named.map((n) =>
      `${n.type ? "type " : ""}${n.imported}${
        n.local === n.imported ? "" : ` as ${n.local}`
      }`
    );
    parts.push(`{ ${names.join(", ")} }`);
  }
  return `import ${typeOnly ? "type " : ""}${parts.join(", ")} from "${spec}";`;
}

// ---------------------------------------------------------------- context --

interface Context {
  original: Source;
  imports: ImportDecl[];
  /** Local name -> std symbol, per std module. */
  stdAssert: Map<string, string>;
  stdMock: Map<string, string>;
  stdTime: Map<string, string>;
  /** Names bound (without `using`) to a std spy or stub. */
  spies: Set<string>;
  /** Names held by `using`: left for hand review, with their assertions. */
  heldSpies: Set<string>;
  /** Std locals the file also declares: shadowed somewhere, never rewritten. */
  shadowed: Set<string>;
  /** Names bound to a constructed Error (`const e = new Error(...)`). */
  errorNames: Set<string>;
  /** Whether the file declares its own binding of the host global's name. */
  hostShadowed: boolean;
  /** The callee that joins paths, and whether it needs an import. */
  join?: { callee: string; needsImport: boolean };
  usable: Map<string, boolean>;
}

function stdBindings(imports: ImportDecl[], spec: RegExp): Map<string, string> {
  const bindings = new Map<string, string>();
  for (const decl of imports) {
    if (!spec.test(decl.spec)) continue;
    for (const n of decl.named ?? []) bindings.set(n.local, n.imported);
  }
  return bindings;
}

const DECLARING = new Set([
  "const",
  "let",
  "var",
  "using",
  "function",
  "class",
]);

/** Words before `(` that open a control statement, not a parameter list. */
const CONTROL_WORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "with",
  "return",
  "typeof",
  "await",
  "new",
]);

/**
 * Whether the file declares `name` other than by its import: a variable,
 * function or class, a typed parameter (or object key), or an untyped
 * parameter of an arrow or function. Conservative: text rules cannot follow
 * scopes, so any such declaration marks the import shadowed.
 */
/** Positions where the file declares `name` other than by its import. */
function declarations(
  src: Source,
  imports: ImportDecl[],
  name: string,
): number[] {
  return occurrences(src, name).filter((pos) =>
    declaresAt(src, imports, name, pos)
  );
}

function isDeclared(src: Source, imports: ImportDecl[], name: string): boolean {
  return declarations(src, imports, name).length > 0;
}

/** The unmatched opening bracket before `pos`, or -1. */
function enclosingOpen(src: Source, pos: number): number {
  let depth = 0;
  for (let j = pos - 1; j >= 0; j--) {
    if (!src.isCode(j)) continue;
    const c = src.text[j];
    if (")]}".includes(c)) depth++;
    else if ("([{".includes(c)) {
      if (depth === 0) return j;
      depth--;
    }
  }
  return -1;
}

/** Whether the occurrence of `name` at `pos` declares it. */
function declaresAt(
  src: Source,
  imports: ImportDecl[],
  name: string,
  pos: number,
): boolean {
  const { text } = src;
  if (insideImport(imports, pos)) return false;
  if (DECLARING.has(wordBefore(text, pos, src.mask).word)) return true;
  const end = pos + name.length;
  const next = nextNonSpace(text, end);
  if (text[next] === ":" || text.startsWith("?:", next)) return true;
  if (text.startsWith("=>", next)) return true;
  let p = prevNonSpace(text, pos, src.mask);
  // A rest element (`...name`) binds like a plain one in a pattern or a
  // parameter list; as a spread in an expression the climb below rejects it.
  if (text.slice(p - 2, p + 1) === "...") {
    p = prevNonSpace(text, p - 2, src.mask);
  }
  const before = text[p];
  if (!"(,{[:".includes(before)) return false;
  // Climb out through any destructuring pattern (`{ a: name }`, `[x, name]`,
  // nested) to what binds it: a declaration keyword, or a parameter list.
  let open = enclosingOpen(src, pos);
  while (open >= 0 && text[open] !== "(") {
    if (DECLARING.has(wordBefore(text, open, src.mask).word)) return true;
    if (!"(,{[:".includes(text[prevNonSpace(text, open, src.mask)])) {
      return false;
    }
    open = enclosingOpen(src, open);
  }
  if (open < 0) return false;
  const keyword = wordBefore(text, open, src.mask).word;
  if (keyword === "catch") return true;
  const close = matchBracket(src, open);
  // A method or constructor: `name(params) {` (or with a return type).
  if (
    close >= 0 && keyword !== "" && !CONTROL_WORDS.has(keyword) &&
    /^\s*(?::[^=;{]+)?\{/.test(text.slice(close + 1))
  ) {
    return true;
  }
  if (close < 0) return false;
  if (/^\s*(?::[^=;{]+)?=>/.test(text.slice(close + 1))) return true;
  if (/function\s*[\w$]*\s*$/.test(text.slice(0, open))) return true;
  return false;
}

function makeContext(text: string): Context {
  const original = new Source(text);
  const imports = parseImports(original);
  const ctx: Context = {
    original,
    imports,
    stdAssert: stdBindings(imports, STD_ASSERT),
    stdMock: stdBindings(imports, STD_MOCK),
    stdTime: stdBindings(imports, STD_TIME),
    spies: new Set(),
    heldSpies: new Set(),
    shadowed: new Set(),
    errorNames: new Set(),
    hostShadowed: false,
    usable: new Map(),
  };
  const mockLocals = [...ctx.stdMock].filter(([, symbol]) =>
    symbol === "spy" || symbol === "stub"
  ).map(([local]) => local);
  for (const local of mockLocals) {
    for (const pos of occurrences(original, local)) {
      const m =
        /(?:^|[^\w$])(const|let|var|using)\s+([\w$]+)\s*(?::[^=]+)?=\s*$/
          .exec(statementHead(text, pos));
      if (m) (m[1] === "using" ? ctx.heldSpies : ctx.spies).add(m[2]);
    }
  }
  for (const bindings of [ctx.stdAssert, ctx.stdMock, ctx.stdTime]) {
    for (const local of bindings.keys()) {
      if (isDeclared(original, imports, local)) ctx.shadowed.add(local);
    }
  }
  ctx.hostShadowed = isDeclared(original, imports, HOST) ||
    imports.some((decl) =>
      !decl.typeOnly && (decl.defaultName === HOST ||
        decl.namespace === HOST ||
        (decl.named ?? []).some((n) => n.local === HOST && !n.type))
    );
  const errorBinding =
    /(?:^|[^\w$])(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:new\s+)?[\w$.]*Error\s*\(/g;
  for (const m of text.matchAll(errorBinding)) {
    if (original.isCode(m.index! + m[0].indexOf(m[1]))) {
      ctx.errorNames.add(m[1]);
    }
  }
  for (const decl of imports) {
    if (decl.typeOnly) continue;
    if (decl.spec === "node:path" || STD_PATH.test(decl.spec)) {
      const named = decl.named?.find((n) => n.imported === "join" && !n.type);
      if (named) ctx.join = { callee: named.local, needsImport: false };
      else if (decl.spec === "node:path") {
        const whole = decl.defaultName ?? decl.namespace;
        if (whole !== undefined && ctx.join === undefined) {
          ctx.join = { callee: `${whole}.join`, needsImport: false };
        }
      }
    }
  }
  if (ctx.join === undefined && canUse(ctx, "join", "node:path")) {
    ctx.join = { callee: "join", needsImport: true };
  }
  return ctx;
}

function insideImport(imports: ImportDecl[], pos: number): boolean {
  return imports.some((decl) => pos >= decl.start && pos < decl.end);
}

/** Names the rewrites import as a module's default export. */
const DEFAULT_IMPORTS = new Set(["assert", "process"]);

/**
 * Whether `name` may be imported from `module` without shadowing anything:
 * it is already imported from there, or the original file never uses it.
 */
function canUse(ctx: Context, name: string, module: string): boolean {
  const key = `${module}#${name}`;
  const cached = ctx.usable.get(key);
  if (cached !== undefined) return cached;
  let usable: boolean;
  const binder = ctx.imports.find((decl) =>
    decl.defaultName === name || decl.namespace === name ||
    (decl.named ?? []).some((n) => n.local === name)
  );
  if (binder !== undefined) {
    // Reused only in the shape the rewrite emits: a default import for
    // `assert` and `process`, an unaliased named import for the rest.
    const shaped = DEFAULT_IMPORTS.has(name)
      ? binder.defaultName === name
      : (binder.named ?? []).some((n) =>
        n.local === name && n.imported === name && !n.type
      );
    // The std `assert` itself is replaced, but only if every use of it is a
    // call (which always converts); a value use would keep it imported.
    usable = (binder.spec === module && !binder.typeOnly && shaped) ||
      (name === "assert" && ctx.stdAssert.get("assert") === "assert" &&
        !ctx.shadowed.has("assert") &&
        occurrences(ctx.original, name).every((pos) =>
          insideImport(ctx.imports, pos) ||
          ctx.original.text[
              nextNonSpace(ctx.original.text, pos + name.length)
            ] === "("
        ));
  } else {
    const uses = occurrences(ctx.original, name).filter((pos) =>
      !insideImport(ctx.imports, pos)
    );
    // The global `process` used as an object is the same one node:process
    // exports, so importing it shadows nothing.
    usable = uses.every((pos) =>
      name === "process" &&
      ctx.original.text[nextNonSpace(ctx.original.text, pos + name.length)] ===
        "."
    );
  }
  ctx.usable.set(key, usable);
  return usable;
}

// ------------------------------------------------------------------ rules --

interface Edit {
  start: number;
  end: number;
  text: string;
}

/** A need is an import the rewrite relies on. */
type Need =
  | "assert"
  | "mock"
  | "process"
  | "tmpdir"
  | "join"
  | "deepEqual"
  | `fs:${string}`
  | `fsSync:${string}`;

interface Rewrite {
  pos: number;
  rule: string;
  edits: Edit[];
  needs: Need[];
}

interface Skip {
  pos: number;
  flag?: Flag;
  reason: string;
}

type Outcome = Rewrite | Skip;

const isSkip = (outcome: Outcome): outcome is Skip => "reason" in outcome;

type Pass = (src: Source, ctx: Context) => Outcome[];

const replaceCall = (
  call: Call,
  rule: string,
  text: string,
  needs: Need[],
): Rewrite => ({
  pos: call.start,
  rule,
  edits: [{ start: call.start, end: call.end, text }],
  needs,
});

const renameCallee = (
  call: Call,
  rule: string,
  callee: string,
  needs: Need[],
): Rewrite => ({
  pos: call.start,
  rule,
  edits: [{ start: call.start, end: call.calleeEnd, text: callee }],
  needs,
});

/** Occurrences of std-bound locals, with the call that follows, if any. */
function stdUses(
  src: Source,
  bindings: Map<string, string>,
): { pos: number; local: string; symbol: string; call?: Call }[] {
  const imports = parseImports(src);
  const uses: { pos: number; local: string; symbol: string; call?: Call }[] =
    [];
  for (const [local, symbol] of bindings) {
    for (const pos of occurrences(src, local)) {
      if (insideImport(imports, pos)) continue;
      const after = nextNonSpace(src.text, pos + local.length);
      if (src.text[after] === ".") continue;
      const call = callAt(src, pos, pos + local.length);
      // A method declared with this name is a declaration, not a call of
      // the import: one with a body (`assertEquals(a, b) { ... }`), a
      // signature with a return type (`assertEquals(a: T): void;` in an
      // interface or type), or an abstract method.
      if (
        call !== undefined &&
        (/^\s*(?::[^=;{]+)?\{/.test(src.text.slice(call.end)) ||
          /^\s*:[^=;{}]+[;,}\n]/.test(src.text.slice(call.end)) ||
          wordBefore(src.text, pos, src.mask).word === "abstract")
      ) {
        continue;
      }
      uses.push({ pos, local, symbol, call });
    }
  }
  return uses.sort((a, b) => a.pos - b.pos);
}

// Assertions -----------------------------------------------------------------

const ASSERT_RENAMES: Record<string, [rule: string, member: string]> = {
  assert: ["assert.ok", "ok"],
  assertEquals: ["assert.equals", "deepStrictEqual"],
  assertStrictEquals: ["assert.strict-equals", "strictEqual"],
  assertNotStrictEquals: ["assert.not-strict-equals", "notStrictEqual"],
  assertMatch: ["assert.match", "match"],
  assertNotMatch: ["assert.not-match", "doesNotMatch"],
  assertObjectMatch: ["assert.object-match", "partialDeepStrictEqual"],
  fail: ["assert.fail", "fail"],
};

const COMPARISONS: Record<string, string> = {
  assertLess: "<",
  assertLessOrEqual: "<=",
  assertGreater: ">",
  assertGreaterOrEqual: ">=",
};

const shadowedSkip = (pos: number, local: string): Skip => ({
  pos,
  reason: `\`${local}\` is also declared in this file, so some uses are ` +
    "shadowed; convert by hand",
});

const ASSERT_SYMBOLS = new Set([
  ...Object.keys(ASSERT_RENAMES),
  ...Object.keys(COMPARISONS),
  "assertInstanceOf",
  "assertArrayIncludes",
  "assertNotEquals",
  "assertFalse",
  "assertStringIncludes",
  "assertThrows",
  "assertRejects",
]);

function looksLikeError(text: string, ctx: Context): boolean {
  return ctx.errorNames.has(text) ||
    // A name bound to a constructed Error, anywhere inside the operand.
    [...ctx.errorNames].some((name) =>
      new RegExp(
        `(?<![\\w$.])${name.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}(?![\\w$])`,
      )
        .test(text)
    ) ||
    /\bnew\s+[\w$.]*Error\s*\(/.test(text) ||
    // An object literal holding an Error-shaped property value.
    /[{,]\s*[\w$]+\s*:\s*(?:new\s+)?[\w$.]*Error\s*\(/.test(text) ||
    /^[\w$.]*Error\s*\(/.test(text) ||
    /(?:^|\.)(?:err|error|cause|thrown|caught)$/i.test(text);
}

/** Whether the value of the call starting at `pos` is used. */
function valueUsed(src: Source, pos: number): boolean {
  const { text, mask } = src;
  let before = wordBefore(text, pos, mask);
  let p = prevNonSpace(text, pos, mask);
  if (before.word === "await") {
    p = prevNonSpace(text, before.start, mask);
    before = wordBefore(text, before.start, mask);
  }
  if (p < 0 || ";{})".includes(text[p])) return false;
  // A concise arrow body returns the value; only a test registration's
  // callback ignores what it returns.
  if (text[p] === ">" && text[p - 1] === "=") {
    return !REGISTRATION_CALLEE.test(enclosingCallee(src, pos));
  }
  if (before.word === "else") return false;
  return true;
}

const HOST_ERROR = new RegExp(`^${HOST}\\.errors\\.`);

function convertAssertion(
  src: Source,
  ctx: Context,
  symbol: string,
  call: Call,
): Outcome {
  const args = call.args;
  const rename = ASSERT_RENAMES[symbol];
  if (rename) {
    if (
      (symbol === "assertEquals" || symbol === "assertObjectMatch") &&
      args.slice(0, 2).some((arg) => looksLikeError(arg.text, ctx))
    ) {
      return {
        pos: call.start,
        flag: "error-equality",
        reason: FLAGS["error-equality"],
      };
    }
    return renameCallee(call, rename[0], `assert.${rename[1]}`, ["assert"]);
  }
  if (symbol === "assertFalse") {
    if (args.length < 1 || args.length > 2) {
      return {
        pos: call.start,
        reason: "assertFalse with unexpected arguments",
      };
    }
    const value = args[0].text;
    const negated = isPostfixChain(value) ? `!${value}` : `!(${value})`;
    const rest = args.slice(1).map((arg) => `, ${arg.text}`).join("");
    return replaceCall(call, "assert.false", `assert.ok(${negated}${rest})`, [
      "assert",
    ]);
  }
  if (symbol === "assertNotEquals") {
    // node's deep inequality passes for -0 against 0 and for a
    // null-prototype object against a plain one, where std's fails: a
    // rewrite could turn a failing test into a passing one.
    return {
      pos: call.start,
      reason: "assertNotEquals: node's notDeepStrictEqual passes where std " +
        "fails (-0 against 0, null-prototype objects); convert by hand, " +
        "for example to notStrictEqual for primitives",
    };
  }
  if (symbol === "assertInstanceOf") {
    if (args.length < 2 || args.length > 3) {
      return {
        pos: call.start,
        reason: "assertInstanceOf with unexpected arguments",
      };
    }
    const rest = args.slice(2).map((arg) => `, ${arg.text}`).join("");
    return replaceCall(
      call,
      "assert.instance-of",
      `assert.ok(${operand(args[0].text)} instanceof ${args[1].text}${rest})`,
      ["assert"],
    );
  }
  if (symbol === "assertArrayIncludes") {
    // Std matches items deeply. `includes` is the same test for primitive
    // literals; any other item goes through isDeepStrictEqual.
    const actual = args[0]?.text ?? "";
    const expected = args[1]?.text ?? "";
    const cast = /^([\s\S]+?)\s+as\s+[\w$<>[\]\s|]+$/.exec(actual);
    const list = cast ? cast[1] : actual;
    if (
      args.length < 2 || args.length > 3 || !expected.startsWith("[") ||
      matchBracket(new Source(expected), 0) !== expected.length - 1 ||
      !isBareName(list)
    ) {
      return {
        pos: call.start,
        reason: "assertArrayIncludes on something other than a bare name " +
          "(it would be evaluated once per item), or with expected items " +
          "that are not an array literal; rewrite by hand",
      };
    }
    const item = ["item", "entry", "member"].find((name) =>
      !new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(actual)
    )!;
    const receiver = cast ? `(${actual})` : actual;
    const rest = args.slice(2).map((arg) => `, ${arg.text}`).join("");
    const items = new Source(expected);
    if (
      splitList(items, 0, expected.length - 1).some((arg) =>
        looksLikeError(arg.text, ctx)
      )
    ) {
      return {
        pos: call.start,
        flag: "error-equality",
        reason: FLAGS["error-equality"],
      };
    }
    const primitive = splitList(items, 0, expected.length - 1).every((arg) =>
      /^(?:"[^"]*"|'[^']*'|`[^`]*`|-?\d[\w.]*|true|false|null|undefined)$/
        .test(arg.text)
    );
    if (!primitive && !canUse(ctx, "isDeepStrictEqual", "node:util")) {
      return {
        pos: call.start,
        reason: "`isDeepStrictEqual` is already bound in this file; " +
          "convert by hand",
      };
    }
    const found = primitive
      ? `${receiver}.includes(${item})`
      : `${receiver}.some((candidate) => isDeepStrictEqual(candidate, ${item}))`;
    return replaceCall(
      call,
      "assert.array-includes",
      `assert.deepStrictEqual(${expected}.filter((${item}) => !${found}), ` +
        `[]${rest})`,
      primitive ? ["assert"] : ["assert", "deepEqual"],
    );
  }
  const comparison = COMPARISONS[symbol];
  if (comparison) {
    if (args.length < 2 || args.length > 3) {
      return { pos: call.start, reason: `${symbol} with unexpected arguments` };
    }
    const [left, right] = [args[0].text, args[1].text];
    const part = (text: string) =>
      isBareName(text) ? `\${${text}}` : templateEscape(text);
    const message = args[2]?.text ??
      `\`expected ${part(left)} ${comparison} ${part(right)}\``;
    return replaceCall(
      call,
      "assert.compare",
      `assert.ok(${operand(left)} ${comparison} ${operand(right)}, ${message})`,
      ["assert"],
    );
  }
  if (symbol === "assertStringIncludes") {
    if (args.length < 2 || args.length > 3) {
      return {
        pos: call.start,
        reason: "assertStringIncludes with unexpected arguments",
      };
    }
    const [haystack, needle] = [args[0].text, args[1].text];
    const receiver = isPostfixChain(haystack) ? haystack : `(${haystack})`;
    const part = (text: string) =>
      isBareName(text) ? `\${JSON.stringify(${text})}` : templateEscape(text);
    const message = args[2]?.text ??
      `\`expected ${part(haystack)} to include ${part(needle)}\``;
    return replaceCall(
      call,
      "assert.string-includes",
      `assert.ok(${receiver}.includes(${needle}), ${message})`,
      ["assert"],
    );
  }
  // assertThrows / assertRejects
  const rejects = symbol === "assertRejects";
  const rule = rejects ? "assert.rejects" : "assert.throws";
  const callee = rejects ? "assert.rejects" : "assert.throws";
  if (valueUsed(src, call.start)) {
    return {
      pos: call.start,
      flag: "thrown-value-used",
      reason: FLAGS["thrown-value-used"],
    };
  }
  if (args.length < 1 || args.length > 4) {
    return { pos: call.start, reason: `${symbol} with unexpected arguments` };
  }
  if (args.length <= 2) return renameCallee(call, rule, callee, ["assert"]);
  const errorClass = args[1].text;
  if (/^["'`]/.test(errorClass) || errorClass === "undefined") {
    return { pos: call.start, reason: `${symbol} with unexpected arguments` };
  }
  if (HOST_ERROR.test(errorClass)) {
    return {
      pos: call.start,
      reason: `${symbol} checks a message on a host error class; ` +
        "write the validation by hand",
    };
  }
  const message = args[3] ? `, ${args[3].text}` : "";
  // No substring to check: the class alone, keeping the assertion message.
  if (args[2].text === "undefined") {
    return replaceCall(
      call,
      rule,
      `${callee}(${args[0].text}, ${errorClass}${message})`,
      ["assert"],
    );
  }
  const validator = `(error: unknown) => error instanceof ${errorClass} && ` +
    `error.message.includes(${args[2].text})`;
  return replaceCall(
    call,
    rule,
    `${callee}(${args[0].text}, ${validator}${message})`,
    ["assert"],
  );
}

const assertionPass: Pass = (src, ctx) =>
  stdUses(src, ctx.stdAssert).map(({ pos, local, symbol, call }): Outcome => {
    if (ctx.shadowed.has(local)) return shadowedSkip(pos, local);
    if (!ASSERT_SYMBOLS.has(symbol)) {
      return { pos, reason: `no rule for @std/assert ${symbol}` };
    }
    if (call === undefined) {
      return { pos, reason: `@std/assert ${symbol} is used but not called` };
    }
    if (call.typeArgs) {
      return { pos, reason: `@std/assert ${symbol} with type arguments` };
    }
    return unusable(ctx, pos, "assert", "node:assert/strict") ??
      convertAssertion(src, ctx, symbol, call);
  });

// Mocks ----------------------------------------------------------------------

const MOCK_SYMBOLS = new Set([
  "spy",
  "stub",
  "assertSpyCalls",
  "assertSpyCall",
]);

/**
 * Whether `name` is bound to a spy or stub this run converted: its binding
 * now reads `mock.fn(` or `mock.method(`. Its reads and spy assertions are
 * rewritten only then; a spy left std keeps its std forms.
 */
function isConvertedSpy(src: Source, name: string): boolean {
  const escaped = name.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  const binding = new RegExp(
    `(?:^|[^\\w$])(?:const|let|var)\\s+${escaped}\\s*(?::[^=]+)?=\\s*` +
      "mock\\.(?:fn|method)\\s*\\(",
    "g",
  );
  // Only a binding in code counts, not one quoted in a comment or string.
  return [...src.text.matchAll(binding)].some((m) =>
    src.isCode(m.index! + m[0].search(/\S/))
  );
}

/**
 * Whether every declaration of `name` in the original file binds it straight
 * to a std spy or stub that converts (no type arguments, a supported
 * argument count, not held by `using`), so that all of them convert and
 * every read of the name is a converted spy's.
 */
function onlySpyBindings(ctx: Context, name: string): boolean {
  const creators = [...ctx.stdMock].filter(([, symbol]) =>
    symbol === "spy" || symbol === "stub"
  ).map(([local]) => local);
  const { text } = ctx.original;
  if (ctx.heldSpies.has(name)) return false;
  // A later assignment can hold a spy the tool did not create.
  const reassigned = occurrences(ctx.original, name).some((pos) =>
    !declaresAt(ctx.original, ctx.imports, name, pos) &&
    ASSIGNMENT.test(text.slice(pos + name.length))
  );
  if (reassigned) return false;
  return declarations(ctx.original, ctx.imports, name).every((pos) => {
    const after = text.slice(pos + name.length);
    return creators.some((local) => {
      const m = new RegExp(`^\\s*(?::[^=]+)?=\\s*${local}\\s*\\(`)
        .exec(after);
      if (!m) return false;
      // The creation must itself convert: spy takes 0-2 arguments, stub 2-3.
      const at = text.indexOf(local, pos + name.length);
      const call = callAt(ctx.original, at, at + local.length);
      if (call === undefined) return false;
      const n = call.args.length;
      return ctx.stdMock.get(local) === "spy" ? n <= 2 : n === 2 || n === 3;
    });
  });
}

/** An assignment operator (plain or compound) at the start of the text. */
const ASSIGNMENT = /^\s*(?:[-+*/%&|^]|\*\*|<<|>>>?|&&|\|\||\?\?)?=(?!=)/;

/** The name a spy or stub at `pos` is bound to by `const|let|var`, if any. */
function spyBinding(text: string, pos: number): string | undefined {
  return /(?:^|[^\w$])(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*$/
    .exec(statementHead(text, pos))?.[1];
}

function heldByUsing(text: string, pos: number): boolean {
  return /\busing\s+[\w$]+\s*(?::[^=]+)?=\s*$/.test(
    statementHead(text, pos),
  );
}

function convertMock(
  src: Source,
  ctx: Context,
  symbol: string,
  call: Call,
): Outcome {
  const args = call.args;
  const pos = call.start;
  if (symbol === "spy" || symbol === "stub") {
    if (heldByUsing(src.text, pos)) {
      return { pos, flag: "using-mock", reason: FLAGS["using-mock"] };
    }
    const blocked = unusable(ctx, pos, "mock", "node:test");
    if (blocked) return blocked;
    const bound = spyBinding(src.text, pos);
    if (bound !== undefined && !onlySpyBindings(ctx, bound)) {
      return {
        pos,
        reason: `${symbol} is bound to \`${bound}\`, a name the file also ` +
          "declares as something else; convert by hand",
      };
    }
    if (!bound) {
      return {
        pos,
        reason: `${symbol} is not bound to a name the tool can follow, so ` +
          "its restore and call-record reads cannot be rewritten; convert " +
          "by hand",
      };
    }
    if (symbol === "spy" && args.length <= 1) {
      return renameCallee(call, "mock.spy", "mock.fn", ["mock"]);
    }
    if (symbol === "spy" && args.length === 2) {
      return renameCallee(call, "mock.spy", "mock.method", ["mock"]);
    }
    if (symbol === "stub" && args.length === 3) {
      return renameCallee(call, "mock.stub", "mock.method", ["mock"]);
    }
    if (symbol === "stub" && args.length === 2) {
      return {
        pos,
        rule: "mock.stub",
        edits: [
          { start: call.start, end: call.calleeEnd, text: "mock.method" },
          { start: args[1].end, end: args[1].end, text: ", () => {}" },
        ],
        needs: ["mock"],
      };
    }
    return { pos, reason: `${symbol} with unexpected arguments` };
  }
  const target = args[0]?.text ?? "";
  const blocked = unusable(ctx, pos, "assert", "node:assert/strict") ??
    unusable(ctx, pos, "mock", "node:test");
  if (blocked) return blocked;
  if (!ctx.heldSpies.has(target) && !isConvertedSpy(src, target)) {
    return {
      pos,
      reason: `${symbol} on \`${target}\`, which is not a spy the tool ` +
        "converted; convert by hand",
    };
  }
  if (ctx.heldSpies.has(target)) {
    return {
      pos,
      reason: `${symbol} on a mock held by \`using\`; convert it with the mock`,
    };
  }
  const receiver = isPostfixChain(target) ? target : `(${target})`;
  if (symbol === "assertSpyCalls") {
    if (args.length !== 2) {
      return { pos, reason: "assertSpyCalls with unexpected arguments" };
    }
    return replaceCall(
      call,
      "mock.assert-spy-calls",
      `assert.equal(${receiver}.mock.callCount(), ${args[1].text})`,
      ["assert"],
    );
  }
  // assertSpyCall
  if (!isStatementStart(src, pos) || !isStatementEnd(src.text, call.end)) {
    return { pos, reason: "assertSpyCall outside a statement of its own" };
  }
  if (args.length === 2) {
    return replaceCall(
      call,
      "mock.assert-spy-call",
      `assert.ok(${receiver}.mock.calls[${args[1].text}])`,
      ["assert"],
    );
  }
  const expected = args.length === 3 ? objectProps(args[2].text) : undefined;
  if (
    expected === undefined || expected.size === 0 ||
    [...expected.keys()].some((key) => key !== "args" && key !== "returned")
  ) {
    return {
      pos,
      reason: "assertSpyCall expects more than args and returned; " +
        "assert on mock.calls by hand",
    };
  }
  const record = `${receiver}.mock.calls[${args[1].text}]`;
  const statements: string[] = [];
  if (expected.has("args")) {
    statements.push(
      `assert.deepStrictEqual(${record}.arguments, ${expected.get("args")})`,
    );
  }
  if (expected.has("returned")) {
    statements.push(
      `assert.deepStrictEqual(${record}.result, ${expected.get("returned")})`,
    );
  }
  return replaceCall(
    call,
    "mock.assert-spy-call",
    statements.join(`;\n${indentAt(src.text, pos)}`),
    ["assert"],
  );
}

const mockPass: Pass = (src, ctx) =>
  stdUses(src, ctx.stdMock).map(({ pos, local, symbol, call }): Outcome => {
    if (ctx.shadowed.has(local)) return shadowedSkip(pos, local);
    if (!MOCK_SYMBOLS.has(symbol)) {
      return { pos, reason: `no rule for @std/testing/mock ${symbol}` };
    }
    if (call === undefined) {
      return {
        pos,
        reason: `@std/testing/mock ${symbol} is used but not called`,
      };
    }
    if (call.typeArgs) {
      return { pos, reason: `@std/testing/mock ${symbol} with type arguments` };
    }
    return convertMock(src, ctx, symbol, call);
  });

/** `s.restore()` and `s.calls` on names bound to a converted spy or stub. */
const spyMemberPass: Pass = (src, ctx) => {
  const outcomes: Outcome[] = [];
  for (const name of ctx.spies) {
    // A spy whose creation stayed std keeps its std reads.
    if (!isConvertedSpy(src, name)) continue;
    for (const pos of occurrences(src, name)) {
      const dot = nextCode(src, pos + name.length);
      // A member read, plain or optional (`s.restore()`, `s?.restore()`).
      if (src.text[dot] !== "." && !src.text.startsWith("?.", dot)) continue;
      const member = /^\??\.\s*([\w$]+)/.exec(src.text.slice(dot));
      if (!member) continue;
      const memberStart = dot + member[0].length - member[1].length;
      const memberEnd = dot + member[0].length;
      if (member[1] === "restore") {
        outcomes.push({
          pos,
          rule: "mock.restore",
          edits: [{ start: memberStart, end: memberStart, text: "mock." }],
          needs: [],
        });
        continue;
      }
      if (member[1] !== "calls") continue;
      const after = nextNonSpace(src.text, memberEnd);
      const length = /^\.\s*length\b/.exec(src.text.slice(after));
      if (length) {
        outcomes.push({
          pos,
          rule: "mock.calls",
          edits: [{
            start: memberStart,
            end: after + length[0].length,
            text: "mock.callCount()",
          }],
          needs: [],
        });
        continue;
      }
      if (src.text[after] === "[") {
        const close = matchBracket(src, after);
        const field = close < 0 ? null : /^\.\s*(args|returned)\b/.exec(
          src.text.slice(nextNonSpace(src.text, close + 1)),
        );
        if (field) {
          const fieldStart = nextNonSpace(src.text, close + 1) +
            field[0].length - field[1].length;
          outcomes.push({
            pos,
            rule: "mock.calls",
            edits: [
              { start: memberStart, end: memberStart, text: "mock." },
              {
                start: fieldStart,
                end: fieldStart + field[1].length,
                text: field[1] === "args" ? "arguments" : "result",
              },
            ],
            needs: [],
          });
          continue;
        }
      }
      outcomes.push({
        pos,
        reason: "spy call records read through a callback or destructuring; " +
          "use mock.calls with arguments/result by hand",
      });
    }
  }
  return outcomes;
};

const timePass: Pass = (src, ctx) =>
  stdUses(src, ctx.stdTime).map(({ pos, symbol }): Outcome =>
    symbol === "FakeTime"
      ? { pos, flag: "fake-time", reason: FLAGS["fake-time"] }
      : { pos, reason: `no rule for @std/testing/time ${symbol}` }
  );

// Host runtime calls ---------------------------------------------------------

interface HostRef {
  start: number;
  /** End of the `HOST.a.b` chain. */
  end: number;
  path: string[];
}

const HOST_REF = new RegExp(`${HOST}((?:\\.[\\w$]+)+)`, "g");

function hostRefs(src: Source): HostRef[] {
  const refs: HostRef[] = [];
  for (const m of src.text.matchAll(HOST_REF)) {
    const start = m.index!;
    if (!src.isCode(start)) continue;
    if (
      start > 0 &&
      (IDENT.test(src.text[start - 1]) || src.text[start - 1] === "#")
    ) {
      continue;
    }
    if (isMember(src, start)) continue;
    refs.push({
      start,
      end: start + m[0].length,
      path: m[1].slice(1).split("."),
    });
  }
  return refs;
}

/** Bare host references (`HOST` not followed by a member). */
function bareHostRefs(src: Source): number[] {
  return occurrences(src, HOST).filter((pos) =>
    src.text[nextNonSpace(src.text, pos + HOST.length)] !== "."
  );
}

const REGISTRATION = new Set([
  "test",
  "TestContext",
  "TestDefinition",
  "TestStepDefinition",
]);

const STAT_FIELDS: Record<string, string> = {
  isFile: "isFile()",
  isDirectory: "isDirectory()",
  isSymlink: "isSymbolicLink()",
  isSocket: "isSocket()",
  isFifo: "isFIFO()",
  isCharDevice: "isCharacterDevice()",
  isBlockDevice: "isBlockDevice()",
};

/** Stat fields whose node value means the same as the host's. */
const STAT_VALUES = new Set([
  "mode",
  "size",
  "mtime",
  "atime",
  "birthtime",
  "ctime",
  "dev",
  "ino",
  "uid",
  "gid",
  "nlink",
  "blocks",
  "blksize",
  "rdev",
]);

const ASSERTION_CALLEES =
  /^(?:assert\.rejects|assert\.throws|assertRejects|assertThrows)$/;

/**
 * Whether the result of the host call at `pos` is used: not a statement of
 * its own, and not the body of an arrow handed to a throw/reject assertion
 * (which looks only at whether it settles).
 */
function resultUsed(src: Source, pos: number): boolean {
  if (!valueUsed(src, pos)) return false;
  const p = prevNonSpace(src.text, pos, src.mask);
  const arrow = src.text[p] === ">" && src.text[p - 1] === "=";
  return !(arrow && ASSERTION_CALLEES.test(enclosingCallee(src, pos)));
}

/** Host fs functions renamed one-for-one: host name -> [rule, node name]. */
const FS_RENAMES: Record<string, [string, string]> = {
  remove: ["fs.remove", "rm"],
  mkdir: ["fs.mkdir", "mkdir"],
  realPath: ["fs.real-path", "realpath"],
  chmod: ["fs.chmod", "chmod"],
  rename: ["fs.rename", "rename"],
};

function fsNeed(name: string, sync: boolean): Need {
  return sync ? `fsSync:${name}` : `fs:${name}`;
}

function fsModule(sync: boolean): string {
  return sync ? "node:fs" : "node:fs/promises";
}

/** The skip for a node name the file already binds to something else. */
function unusable(
  ctx: Context,
  pos: number,
  name: string,
  module: string,
): Skip | undefined {
  return canUse(ctx, name, module) ? undefined : {
    pos,
    reason: `\`${name}\` is already bound in this file; convert by hand`,
  };
}

function convertFs(
  src: Source,
  ctx: Context,
  ref: HostRef,
  call: Call | undefined,
): Outcome {
  const pos = ref.start;
  const fullName = ref.path[0];
  const sync = fullName.endsWith("Sync");
  const base = sync ? fullName.slice(0, -"Sync".length) : fullName;
  const host = `${HOST}.${fullName}`;
  if (call === undefined) return { pos, reason: `${host} is not called` };
  const args = call.args;
  const named = (node: string) => sync ? `${node}Sync` : node;
  const blocked = (node: string) =>
    unusable(ctx, pos, named(node), fsModule(sync));
  const callee = (node: string): Edit => ({
    start: ref.start,
    end: ref.end,
    text: named(node),
  });

  if (base === "remove") {
    // node's rm rejects a directory unless it is recursive, while the host's
    // remove also takes an empty one: only a provably recursive call is safe.
    const options = args.length === 2 ? objectProps(args[1].text) : undefined;
    if (options?.get("recursive") !== "true") {
      return {
        pos,
        reason: `${host} without { recursive: true } may remove an empty ` +
          "directory, which rm rejects; use unlink or rmdir by hand",
      };
    }
  }
  if (base === "mkdir" && resultUsed(src, pos)) {
    return {
      pos,
      reason: `${host} result is used; node's recursive mkdir resolves to ` +
        "the first directory it made, the host's to nothing; convert by hand",
    };
  }
  const rename = FS_RENAMES[base];
  if (rename) {
    return blocked(rename[1]) ?? {
      pos,
      rule: rename[0],
      edits: [callee(rename[1])],
      needs: [fsNeed(named(rename[1]), sync)],
    };
  }
  if (base === "makeTempDir") {
    const props = args.length === 0
      ? new Map<string, string>()
      : args.length === 1
      ? objectProps(args[0].text)
      : undefined;
    if (
      props === undefined ||
      [...props.keys()].some((key) => key !== "prefix" && key !== "dir")
    ) {
      return {
        pos,
        reason: `${host} with options other than prefix and dir`,
      };
    }
    if (ctx.join === undefined) {
      return { pos, reason: "no usable path join in this file" };
    }
    const skip = blocked("mkdtemp") ??
      (props.has("dir") ? undefined : unusable(ctx, pos, "tmpdir", "node:os"));
    if (skip) return skip;
    const dir = props.get("dir") ?? "tmpdir()";
    const prefix = props.get("prefix") ?? '"tmp-"';
    // mkdtemp appends its suffix to the path it is given: an empty prefix
    // would name a sibling of the directory, not an entry in it.
    if (!/^(["'])[^"'\\]+\1$|^`[^`$\\]+`$/.test(prefix)) {
      return {
        pos,
        reason: `${host} with a prefix that is not a non-empty string ` +
          "literal; mkdtemp would name a sibling if it were empty, so " +
          "convert by hand",
      };
    }
    const needs: Need[] = [fsNeed(named("mkdtemp"), sync)];
    if (!props.has("dir")) needs.push("tmpdir");
    if (ctx.join.needsImport) needs.push("join");
    return replaceCall(
      { ...call, start: ref.start },
      "fs.make-temp-dir",
      `${named("mkdtemp")}(${ctx.join.callee}(${dir}, ${prefix}))`,
      needs,
    );
  }
  if (base === "readTextFile") {
    if (args.length !== 1) {
      return { pos, reason: `${host} with options` };
    }
    return blocked("readFile") ?? {
      pos,
      rule: "fs.read-text-file",
      edits: [callee("readFile"), {
        start: args[0].end,
        end: args[0].end,
        text: ', "utf8"',
      }],
      needs: [fsNeed(named("readFile"), sync)],
    };
  }
  if (base === "writeTextFile") {
    if (args.length === 2) {
      return blocked("writeFile") ?? {
        pos,
        rule: "fs.write-text-file",
        edits: [callee("writeFile")],
        needs: [fsNeed(named("writeFile"), sync)],
      };
    }
    const props = args.length === 3 ? objectProps(args[2].text) : undefined;
    if (
      props === undefined ||
      [...props.keys()].some((key) => key !== "append" && key !== "mode") ||
      (props.has("append") && props.get("append") !== "true")
    ) {
      return { pos, reason: `${host} with options other than append and mode` };
    }
    const node = props.has("append") ? "appendFile" : "writeFile";
    const options = props.has("mode") ? `, { mode: ${props.get("mode")} }` : "";
    return blocked(node) ?? {
      pos,
      rule: "fs.write-text-file",
      edits: [callee(node), {
        start: args[1].end,
        end: args[2].end,
        text: options,
      }],
      needs: [fsNeed(named(node), sync)],
    };
  }
  if (base === "stat" || base === "lstat") {
    if (args.length !== 1) return { pos, reason: `${host} with options` };
    const edits = [callee(base)];
    let after = nextNonSpace(src.text, call.end);
    let opener = prevNonSpace(src.text, pos);
    if (wordBefore(src.text, pos).word === "await") {
      opener = prevNonSpace(src.text, wordBefore(src.text, pos).start);
    }
    if (src.text[after] === ")" && src.text[opener] === "(") {
      after = nextNonSpace(src.text, after + 1);
    }
    const field = /^\??\.\s*([\w$]+)/.exec(src.text.slice(after));
    const ignoresResult = /^\.\s*then\s*\(\s*(?:async\s*)?\(\s*\)\s*=>/
      .test(src.text.slice(after));
    if (
      field && !STAT_FIELDS[field[1]] && !STAT_VALUES.has(field[1]) &&
      !ignoresResult
    ) {
      return {
        pos,
        reason: `${host} result is passed on (.${field[1]}); its is* fields ` +
          "become methods in node:fs, so convert by hand",
      };
    }
    if (field && STAT_FIELDS[field[1]]) {
      const fieldStart = after + field[0].length - field[1].length;
      edits.push({
        start: fieldStart,
        end: fieldStart + field[1].length,
        text: STAT_FIELDS[field[1]],
      });
    } else if (field === null && resultUsed(src, pos)) {
      // The whole result goes somewhere: its is* fields become methods in
      // node:fs, and its later reads cannot be followed by text rules.
      return {
        pos,
        reason: `${host} result is bound or passed on; its is* fields ` +
          "become methods in node:fs, so convert its reads by hand",
      };
    }
    return blocked(base) ?? {
      pos,
      rule: "fs.stat",
      edits,
      needs: [fsNeed(named(base), sync)],
    };
  }
  if (base === "symlink") {
    if (args.length === 2) {
      return blocked("symlink") ?? {
        pos,
        rule: "fs.symlink",
        edits: [callee("symlink")],
        needs: [fsNeed(named("symlink"), sync)],
      };
    }
    const props = args.length === 3 ? objectProps(args[2].text) : undefined;
    if (props === undefined || props.size !== 1 || !props.has("type")) {
      return { pos, reason: `${host} with options other than type` };
    }
    return blocked("symlink") ?? {
      pos,
      rule: "fs.symlink",
      edits: [callee("symlink"), {
        start: args[2].start,
        end: args[2].end,
        text: props.get("type")!,
      }],
      needs: [fsNeed(named("symlink"), sync)],
    };
  }
  if (base === "readDir") {
    const head = src.text.slice(lineStart(src.text, pos), pos);
    const loop = sync
      ? /for\s*\(\s*(const|let)\s+([\w$]+)\s+of\s*$/.exec(head)
      : /for\s+await\s*\(\s*(const|let)\s+([\w$]+)\s+of\s*$/.exec(head);
    const headerClose = nextNonSpace(src.text, call.end);
    if (!loop || args.length !== 1 || src.text[headerClose] !== ")") {
      return {
        pos,
        reason: `${host} outside a for-of loop; list the directory with ` +
          "readdir by hand",
      };
    }
    const node = sync ? "readdirSync" : "readdir";
    const listing = `${node}(${args[0].text}, { withFileTypes: true })`;
    const edits: Edit[] = sync
      ? [{ start: ref.start, end: call.end, text: listing }]
      : [{
        start: lineStart(src.text, pos) + loop.index,
        end: call.end,
        text: `for (${loop[1]} ${loop[2]} of await ${listing}`,
      }];
    const bodyStart = nextNonSpace(src.text, headerClose + 1);
    // Only a braced body has an end text rules can find safely.
    if (src.text[bodyStart] !== "{") {
      return {
        pos,
        reason: `${host} loop without a braced body; convert by hand`,
      };
    }
    const bodyEnd = matchBracket(src, bodyStart);
    // A body that declares the entry name again shadows it somewhere, and
    // its is* reads cannot be told apart by text.
    const bodyImports = parseImports(src);
    // Assigning the name in the body puts something else in it too.
    if (
      occurrences(src, loop[2]).some((at) =>
        at > bodyStart && at < bodyEnd &&
        (declaresAt(src, bodyImports, loop[2], at) ||
          ASSIGNMENT.test(src.text.slice(at + loop[2].length)))
      )
    ) {
      return {
        pos,
        reason:
          `${host} loop body declares or assigns \`${loop[2]}\`; convert ` +
          "by hand",
      };
    }
    const entry = new RegExp(
      `(?<![\\w$.])${loop[2]}\\s*\\??\\.\\s*([\\w$]+)`,
      "g",
    );
    for (const m of src.text.slice(bodyStart, bodyEnd).matchAll(entry)) {
      const at = bodyStart + m.index!;
      const fieldEnd = at + m[0].length;
      if (!src.isCode(at) || !STAT_FIELDS[m[1]]) continue;
      if (src.text[nextNonSpace(src.text, fieldEnd)] === "(") continue;
      edits.push({
        start: fieldEnd - m[1].length,
        end: fieldEnd,
        text: STAT_FIELDS[m[1]],
      });
    }
    return unusable(ctx, pos, node, fsModule(sync)) ?? {
      pos,
      rule: "fs.read-dir",
      edits,
      needs: [fsNeed(node, sync)],
    };
  }
  if (base === "makeTempFile") {
    return {
      pos,
      reason: `${host} has no node counterpart; write a file inside a ` +
        "mkdtemp directory by hand",
    };
  }
  return { pos, reason: `no rule for ${host}` };
}

const ERROR_CHECKS: Record<
  string,
  [rule: string, field: string, value: string]
> = {
  NotFound: ["errors.code", "code", "ENOENT"],
  AlreadyExists: ["errors.code", "code", "EEXIST"],
  NotCapable: ["errors.not-capable", "name", "NotCapable"],
};

function enclosingCallee(src: Source, pos: number): string {
  let depth = 0;
  for (let j = pos - 1; j >= 0; j--) {
    if (!src.isCode(j)) continue;
    const c = src.text[j];
    if (")]}".includes(c)) depth++;
    else if ("([{".includes(c)) {
      if (depth === 0) {
        if (c !== "(") return "";
        const m = /([\w$.]+)\s*$/.exec(src.text.slice(0, j));
        return m ? m[1] : "";
      }
      depth--;
    }
  }
  return "";
}

function convertError(src: Source, ref: HostRef): Outcome {
  const pos = ref.start;
  const name = ref.path[1];
  const host = `${HOST}.errors.${name}`;
  const check = ERROR_CHECKS[name];
  if (ref.path.length !== 2 || check === undefined) {
    return { pos, reason: `no rule for ${host}` };
  }
  if (wordBefore(src.text, pos).word === "new") {
    return { pos, reason: `${host} is constructed; build the error by hand` };
  }
  const [rule, field, value] = check;
  const before = prevNonSpace(src.text, pos);
  const after = src.text[nextNonSpace(src.text, ref.end)];
  const callee = enclosingCallee(src, pos);
  if (
    src.text[before] === "," && (after === ")" || after === ",") &&
    (callee === "assert.throws" || callee === "assert.rejects")
  ) {
    return {
      pos,
      rule,
      edits: [{
        start: ref.start,
        end: ref.end,
        // An Error with the matching code: a plain object carrying the code
        // is not the host's error class and must not pass.
        text: `(error: unknown) => error instanceof Error && ` +
          `(error as { ${field}?: unknown }).${field} === "${value}"`,
      }],
      needs: [],
    };
  }
  const keyword = wordBefore(src.text, pos);
  if (keyword.word === "instanceof") {
    const operandEnd = prevNonSpace(src.text, keyword.start) + 1;
    let operandStart = operandEnd;
    while (operandStart > 0 && /[\w$.]/.test(src.text[operandStart - 1])) {
      operandStart--;
    }
    const operand = src.text.slice(operandStart, operandEnd);
    // The operand is read twice, so only a bare name qualifies. Requiring
    // an Error keeps a plain object with the right code from passing, and
    // gives false for null, undefined or a primitive, as instanceof does.
    if (isBareName(operand)) {
      return {
        pos,
        rule,
        edits: [{
          start: operandStart,
          end: ref.end,
          text: `(${operand} instanceof Error && ` +
            `(${operand} as { ${field}?: unknown }).${field} === "${value}")`,
        }],
        needs: [],
      };
    }
  }
  return {
    pos,
    reason: `${host} outside an assertion argument or an instanceof test`,
  };
}

/**
 * Host platform names with a one-to-one `process.platform` value. Solaris and
 * illumos both report "sunos" in node, so neither maps.
 */
const PLATFORMS: Record<string, string> = {
  darwin: "darwin",
  linux: "linux",
  android: "android",
  freebsd: "freebsd",
  openbsd: "openbsd",
  aix: "aix",
  windows: "win32",
};

const PROTOTYPE_NAMES = new Set(Object.getOwnPropertyNames(Object.prototype));

/** A literal key that no plain object inherits. */
function ownKey(key: string): boolean {
  const m = /^(["'])([^"'\\]*)\1$/.exec(key);
  return m !== null && !PROTOTYPE_NAMES.has(m[2]);
}

function envAccess(key: string): string {
  const m = /^(["'])([A-Za-z_][\w]*)\1$/.exec(key);
  return m ? `.${m[2]}` : `[${key}]`;
}

/** Whether the expression [start, end) stands alone in its context. */
function standsAlone(src: Source, start: number, end: number): boolean {
  const { text, mask } = src;
  const p = prevNonSpace(text, start, mask);
  const before = text[p];
  const alone = p < 0 || "(,;{".includes(before) ||
    (before === "=" && !"=!<>".includes(text[p - 1])) ||
    wordBefore(text, start, mask).word === "return";
  return alone && "),;".includes(text[nextNonSpace(text, end)]);
}

function convertProcess(
  src: Source,
  ctx: Context,
  ref: HostRef,
  call: Call | undefined,
): Outcome {
  const pos = ref.start;
  const host = `${HOST}.${ref.path.join(".")}`;
  const blocked = unusable(ctx, pos, "process", "node:process");
  const [head, member] = ref.path;
  const swap = (rule: string, end: number, text: string): Outcome =>
    blocked ?? {
      pos,
      rule,
      edits: [{ start: ref.start, end, text }],
      needs: ["process"],
    };
  if (head === "cwd" && ref.path.length === 1 && call?.args.length === 0) {
    return swap("process.cwd", call.end, "process.cwd()");
  }
  if (head === "execPath" && ref.path.length === 1 && call?.args.length === 0) {
    return swap("process.exec-path", call.end, "process.execPath");
  }
  if (head === "pid" && ref.path.length === 1 && call === undefined) {
    return swap("process.pid", ref.end, "process.pid");
  }
  if (head === "build" && member === "os" && ref.path.length === 2) {
    // The host names Windows "windows" and node "win32", so only a direct
    // comparison with a string literal, whose literal can be mapped too,
    // keeps its meaning; a stored or otherwise compared value may not.
    // The literal must be the whole right operand: what follows it ends
    // the comparison (`"windows".replace(...)` would not be a literal).
    const compared =
      /^\s*[!=]==?\s*(["'])([^"'\\]*)\1(?=\s*(?:[);,}\]?:]|&&|\|\||$))/
        .exec(src.text.slice(ref.end));
    if (!compared) {
      return {
        pos,
        reason: `${host} is stored or compared with something other than ` +
          'a string literal; its Windows value ("windows") differs from ' +
          'process.platform ("win32"), so convert by hand',
      };
    }
    const mapped = PLATFORMS[compared[2]];
    if (mapped === undefined) {
      return {
        pos,
        reason: `${host} compared with "${compared[2]}", which has no ` +
          "one-to-one process.platform value; convert by hand",
      };
    }
    const outcome = swap("process.platform", ref.end, "process.platform");
    if (!isSkip(outcome) && mapped !== compared[2]) {
      const literalEnd = ref.end + compared[0].length;
      outcome.edits.push({
        start: literalEnd - compared[2].length - 2,
        end: literalEnd,
        text: `"${mapped}"`,
      });
    }
    return outcome;
  }
  if (head === "env" && ref.path.length === 2 && call !== undefined) {
    const args = call.args;
    const key = args[0]?.text ?? "";
    if (/^(["'])__proto__\1$/.test(key)) {
      return { pos, reason: `${host} on "__proto__"; convert by hand` };
    }
    // process.env is a plain object: a key that may be inherited from
    // Object.prototype is read through an own-property check, as the host's
    // map does. A literal key that is not a prototype name reads directly.
    if (member === "get" && args.length === 1) {
      if (ownKey(key)) {
        return swap("process.env", call.end, `process.env${envAccess(key)}`);
      }
      // The key is read twice below, so it must be safe to evaluate twice.
      if (!isBareName(key) && !/^(["'])[^"'\\]*\1$/.test(key)) {
        return {
          pos,
          reason: `${host} with a computed key that would be evaluated ` +
            "twice; convert by hand",
        };
      }
      const read = `Object.hasOwn(process.env, ${key}) ? ` +
        `process.env${envAccess(key)} : undefined`;
      return swap(
        "process.env",
        call.end,
        standsAlone(src, pos, call.end) ? read : `(${read})`,
      );
    }
    if (member === "has" && args.length === 1) {
      return swap(
        "process.env",
        call.end,
        `Object.hasOwn(process.env, ${key})`,
      );
    }
    const statement = isStatementStart(src, pos) &&
      isStatementEnd(src.text, call.end);
    if (member === "set" && args.length === 2 && statement) {
      return swap(
        "process.env",
        call.end,
        `process.env${envAccess(args[0].text)} = ${args[1].text}`,
      );
    }
    if (member === "delete" && args.length === 1 && statement) {
      return swap(
        "process.env",
        call.end,
        `delete process.env${envAccess(args[0].text)}`,
      );
    }
  }
  if (head === "env") {
    return {
      pos,
      reason: `${host} in a form the rules do not cover; use process.env ` +
        "by hand",
    };
  }
  return { pos, reason: `no rule for ${host}` };
}

const FS_FUNCTIONS = new Set([
  "makeTempDir",
  "makeTempFile",
  "remove",
  "mkdir",
  "readTextFile",
  "writeTextFile",
  "stat",
  "lstat",
  "realPath",
  "chmod",
  "symlink",
  "rename",
  "readDir",
]);

const PROCESS_MEMBERS = new Set(["cwd", "execPath", "pid", "build", "env"]);

const hostPass: Pass = (src, ctx) => {
  const outcomes: Outcome[] = [];
  for (const ref of hostRefs(src)) {
    const [head] = ref.path;
    const pos = ref.start;
    if (REGISTRATION.has(head)) continue;
    if (ctx.hostShadowed) {
      outcomes.push({
        pos,
        reason: `the file declares its own \`${HOST}\`, so some references ` +
          "reach the local; convert by hand",
      });
      continue;
    }
    if (head === "errors") {
      outcomes.push(convertError(src, ref));
      continue;
    }
    if (head === "exit") {
      outcomes.push({ pos, flag: "exit", reason: FLAGS.exit });
      continue;
    }
    if (head === "permissions") {
      outcomes.push({
        pos,
        flag: "permissions-api",
        reason: FLAGS["permissions-api"],
      });
      continue;
    }
    if (head === "Command") {
      outcomes.push({ pos, flag: "command", reason: FLAGS.command });
      continue;
    }
    const call = callAt(src, ref.start, ref.end);
    const base = head.endsWith("Sync") ? head.slice(0, -"Sync".length) : head;
    if (ref.path.length === 1 && FS_FUNCTIONS.has(base)) {
      outcomes.push(convertFs(src, ctx, ref, call));
    } else if (PROCESS_MEMBERS.has(head)) {
      outcomes.push(convertProcess(src, ctx, ref, call));
    } else {
      outcomes.push({
        pos,
        reason: `no rule for ${HOST}.${ref.path.join(".")}`,
      });
    }
  }
  for (const pos of bareHostRefs(src)) {
    outcomes.push({
      pos,
      reason: `${HOST} is used as an object; convert by hand`,
    });
  }
  // `globalThis.<host>` and `globalThis["<host>"]` (a static key) alike.
  const viaGlobal = new RegExp(
    `\\b(?:globalThis|window|self)\\s*(?:\\??\\.\\s*${HOST}(?![\\w$])|` +
      `(?:\\?\\.)?\\[\\s*(["'\`])${HOST}\\1\\s*\\])`,
    "g",
  );
  for (const m of src.text.matchAll(viaGlobal)) {
    if (!src.isCode(m.index!) || isMember(src, m.index!)) continue;
    outcomes.push({
      pos: m.index!,
      reason: `${HOST} reached through a global object; convert by hand`,
    });
  }
  return outcomes;
};

const REGISTRATION_CALLEE = new RegExp(
  `(?:^|[^\\w$.])(?:${HOST}\\.test(?:\\.(?:only|ignore))?|describe|it|test|` +
    `[\\w$]+\\.step)$`,
);

/**
 * Whether `pos` is a key of the options object passed first to a test
 * registration (`{ name, permissions, ... }`), not a key of other data.
 */
function inRegistrationOptions(src: Source, pos: number): boolean {
  let depth = 0;
  let open = -1;
  for (let j = pos - 1; j >= 0 && open < 0; j--) {
    if (!src.isCode(j)) continue;
    const c = src.text[j];
    if (")]}".includes(c)) depth++;
    else if ("([{".includes(c)) {
      if (depth === 0) open = c === "{" ? j : -2;
      else depth--;
    }
  }
  if (open < 0) return false;
  const paren = prevNonSpace(src.text, open, src.mask);
  if (src.text[paren] !== "(") return false;
  return REGISTRATION_CALLEE.test(
    src.text.slice(lineStart(src.text, paren), paren).trimEnd(),
  );
}

/** Registration options that are reviewed by hand; never rewritten. */
const optionPass: Pass = (src) => {
  const outcomes: Outcome[] = [];
  const options: [RegExp, Flag][] = [
    // A key with a value, or a shorthand key (`{ name, permissions, fn }`).
    [/\bpermissions\s*(?::|(?=[,}]))/g, "test-permissions"],
    [/\bsanitize(?:Ops|Resources|Exit)\s*(?::|(?=[,}]))/g, "sanitizer-options"],
  ];
  // Matched with comments blanked, so `permissions /* why */:` still counts.
  const blanked = blankComments(src);
  for (const [pattern, flag] of options) {
    for (const m of blanked.matchAll(pattern)) {
      const pos = m.index!;
      if (!src.isCode(pos) || isMember(src, pos)) continue;
      const p = prevNonSpace(src.text, pos, src.mask);
      if (!"{,".includes(src.text[p])) continue;
      if (!inRegistrationOptions(src, pos)) continue;
      outcomes.push({ pos, flag, reason: FLAGS[flag] });
    }
  }
  // The same keys quoted (`"permissions":`) or computed (`["permissions"]:`).
  const quoted =
    /(\[\s*)?(["'])(permissions|sanitize(?:Ops|Resources|Exit))\2(\s*\])?\s*:/g;
  for (const m of blanked.matchAll(quoted)) {
    const pos = m.index!;
    if ((m[1] === undefined) !== (m[4] === undefined)) continue;
    const p = prevNonSpace(src.text, pos, src.mask);
    if (p < 0 || !src.isCode(p) || !"{,".includes(src.text[p])) continue;
    if (!inRegistrationOptions(src, pos)) continue;
    const flag: Flag = m[3] === "permissions"
      ? "test-permissions"
      : "sanitizer-options";
    outcomes.push({ pos, flag, reason: FLAGS[flag] });
  }
  return outcomes;
};

/** Regexes the scanner read after a same-line `}`: reported for a look. */
const ambiguityPass: Pass = (src) =>
  src.ambiguous.map(([pos]) => ({
    pos,
    reason: "a `/` after a `}` was read as a regex; if the `}` ends an " +
      "object literal it is division, so check by hand",
  }));

/** Std imports kept whole for their comments, though some names went unused. */
const commentedImportPass: Pass = (src) => {
  const imports = parseImports(src);
  return imports.filter((decl) =>
    decl.hasComments &&
    (STD_ASSERT.test(decl.spec) || STD_MOCK.test(decl.spec)) &&
    (decl.named ?? []).some((n) =>
      !occurrences(src, n.local).some((pos) => !insideImport(imports, pos))
    )
  ).map((decl) => ({
    pos: decl.start,
    reason: "this import holds comments, so it keeps names the file no " +
      "longer uses; remove them by hand",
  }));
};

/** In order: assertions before the host pass, which rewrites their arguments. */
const PASSES: Pass[] = [
  assertionPass,
  mockPass,
  spyMemberPass,
  timePass,
  hostPass,
  optionPass,
  commentedImportPass,
  ambiguityPass,
];

// ------------------------------------------------------------------ driver --

function editText(text: string, edits: Edit[]): string {
  let out = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

/** Maps a position in an edited text back to the text before `edits`. */
function mapBack(edits: Edit[], pos: number): number {
  let delta = 0;
  for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
    const outStart = edit.start + delta;
    if (pos < outStart) return pos - delta;
    if (pos < outStart + edit.text.length) return edit.start;
    delta += edit.text.length - (edit.end - edit.start);
  }
  return pos - delta;
}

function applyEdits(
  text: string,
  rewrites: Rewrite[],
): { text: string; applied: Rewrite[]; edits: Edit[] } {
  const taken: Edit[] = [];
  const applied: Rewrite[] = [];
  const overlaps = (edit: Edit) =>
    taken.some((other) =>
      edit.start < other.end && other.start < edit.end ||
      (edit.start === edit.end && edit.start === other.start) ||
      (other.start === other.end && other.start === edit.start)
    );
  for (const rewrite of [...rewrites].sort((a, b) => a.pos - b.pos)) {
    if (rewrite.edits.some(overlaps)) continue;
    taken.push(...rewrite.edits);
    applied.push(rewrite);
  }
  return { text: editText(text, taken), applied, edits: taken };
}

const NEED_MODULES: Record<string, string> = {
  assert: "node:assert/strict",
  mock: "node:test",
  process: "node:process",
  tmpdir: "node:os",
  join: "node:path",
  deepEqual: "node:util",
  fs: "node:fs/promises",
  fsSync: "node:fs",
};

/**
 * Drops converted std symbols from their imports and adds the node: imports
 * the rewrites need. New import lines go before the first import.
 */
function fixImports(
  text: string,
  ctx: Context,
  needs: Set<Need>,
  count: (rule: string) => void,
): Edit[] {
  const src = new Source(text);
  const imports = parseImports(src);
  // `assert.` reads are the node import's only when this run adds it;
  // otherwise they are reads of the std `assert` and keep it imported.
  const nodeAssert = needs.has("assert");
  // A name inside an ambiguous span (read as a regex, perhaps division)
  // may run, so it keeps its import.
  const inAmbiguous = (local: string) =>
    src.ambiguous.some(([start, end]) =>
      new RegExp(`(?<![\\w$])${local}(?![\\w$])`).test(
        src.text.slice(start, end),
      )
    );
  const used = (local: string) =>
    inAmbiguous(local) ||
    occurrences(src, local).some((pos) =>
      !insideImport(imports, pos) &&
      !(nodeAssert && local === "assert" &&
        src.text[nextNonSpace(src.text, pos + local.length)] === ".")
    );
  const edits = new Map<ImportDecl, string>();
  for (const decl of imports) {
    const assertSpec = STD_ASSERT.test(decl.spec);
    if (!assertSpec && !STD_MOCK.test(decl.spec)) continue;
    const named = decl.named ?? [];
    const kept = named.filter((n) => used(n.local));
    if (kept.length === named.length) continue;
    // Rewriting would drop the comments; the unused names are reported.
    if (decl.hasComments) continue;
    count(assertSpec ? "assert.import" : "mock.import");
    edits.set(
      decl,
      kept.length === 0 && decl.defaultName === undefined
        ? ""
        : renderImport(decl.spec, decl.defaultName, kept, decl.typeOnly),
    );
  }

  const wanted = new Map<
    string,
    { defaultName?: string; named: Set<string> }
  >();
  const want = (module: string) => {
    let entry = wanted.get(module);
    if (!entry) wanted.set(module, entry = { named: new Set() });
    return entry;
  };
  for (const need of needs) {
    const [kind, name] = need.includes(":")
      ? need.split(":")
      : [need, need === "deepEqual" ? "isDeepStrictEqual" : need];
    const entry = want(NEED_MODULES[kind]);
    if (kind === "assert" || kind === "process") entry.defaultName = kind;
    else entry.named.add(name);
  }
  const added: string[] = [];
  for (
    const [module, entry] of [...wanted].sort(([a], [b]) => a < b ? -1 : 1)
  ) {
    const existing = imports.find((decl) =>
      decl.spec === module && !decl.typeOnly && decl.namespace === undefined &&
      !decl.hasComments && !edits.has(decl)
    );
    const named = existing?.named ?? [];
    // What every value import of the module already binds, not only the
    // first one: a name bound by any of them is reused, never added again.
    const present = imports.filter((decl) =>
      decl.spec === module && !decl.typeOnly && !edits.has(decl)
    );
    const missing = [...entry.named].filter((name) =>
      !present.some((decl) =>
        (decl.named ?? []).some((n) =>
          n.local === name && n.imported === name && !n.type
        )
      )
    );
    const needsDefault = entry.defaultName !== undefined &&
      !present.some((decl) => decl.defaultName === entry.defaultName);
    if (!needsDefault && missing.length === 0) continue;
    const defaultName = needsDefault ? entry.defaultName : undefined;
    if (existing && (!needsDefault || existing.defaultName === undefined)) {
      const merged = [
        ...named,
        ...missing.map((name) => ({
          imported: name,
          local: name,
          type: false,
        })),
      ].sort((a, b) => a.imported < b.imported ? -1 : 1);
      edits.set(
        existing,
        renderImport(module, defaultName ?? existing.defaultName, merged),
      );
      continue;
    }
    added.push(
      renderImport(
        module,
        defaultName,
        [...missing].sort().map((name) => ({
          imported: name,
          local: name,
          type: false,
        })),
      ),
    );
  }

  const anchor = imports[0];
  const textEdits: Edit[] = [];
  for (const [decl, replacement] of edits) {
    if (decl === anchor) continue;
    const end = replacement === "" && text[decl.end] === "\n"
      ? decl.end + 1
      : decl.end;
    textEdits.push({ start: decl.start, end, text: replacement });
  }
  if (anchor !== undefined) {
    const lines = [...added];
    const own = edits.get(anchor);
    if (own === undefined) lines.push(text.slice(anchor.start, anchor.end));
    else if (own !== "") lines.push(own);
    if (lines.length > 0 || own !== undefined) {
      const end = lines.length === 0 && text[anchor.end] === "\n"
        ? anchor.end + 1
        : anchor.end;
      textEdits.push({ start: anchor.start, end, text: lines.join("\n") });
    }
  } else if (added.length > 0) {
    const top = /^(?:#![^\n]*\n)?(?:[ \t]*(?:\/\/[^\n]*)?\n)*/.exec(text)![0];
    const at = top.trimEnd().length === 0 ? 0 : top.length;
    textEdits.push({ start: at, end: at, text: `${added.join("\n")}\n\n` });
  }
  return textEdits;
}

const MAX_ROUNDS = 10;

/** Converts one test file's text. Pure: no I/O. */
export function convertSource(text: string): ConversionResult {
  const ctx = makeContext(text);
  const rewrites = new Map<string, number>();
  const count = (rule: string) =>
    rewrites.set(rule, (rewrites.get(rule) ?? 0) + 1);
  const needs = new Set<Need>();
  // Every applied edit batch, in order, to map findings back to `text`.
  const steps: Edit[][] = [];
  let current = text;
  for (const pass of PASSES) {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const pending = pass(new Source(current), ctx).filter((outcome) =>
        !isSkip(outcome)
      ) as Rewrite[];
      if (pending.length === 0) break;
      const { text: next, applied, edits } = applyEdits(current, pending);
      for (const rewrite of applied) {
        count(rewrite.rule);
        for (const need of rewrite.needs) needs.add(need);
      }
      steps.push(edits);
      current = next;
    }
  }
  const importEdits = fixImports(current, ctx, needs, count);
  steps.push(importEdits);
  current = editText(current, importEdits);

  const final = new Source(current);
  const finding = (
    kind: Finding["kind"],
    pos: number,
    message: string,
    flag?: Flag,
  ): Finding => {
    let original = pos;
    for (const edits of [...steps].reverse()) {
      original = mapBack(edits, original);
    }
    return {
      kind,
      ...(flag ? { flag } : {}),
      line: lineOf(current, pos),
      originalLine: lineOf(text, original),
      message,
    };
  };
  const findings: Finding[] = [];
  for (const pass of PASSES) {
    for (const outcome of pass(final, ctx)) {
      if (!isSkip(outcome)) continue;
      findings.push(
        finding(
          outcome.flag ? "hand-review" : "unconverted",
          outcome.pos,
          outcome.reason,
          outcome.flag,
        ),
      );
    }
  }
  const word = new RegExp(`(?<![\\w$])${HOST}(?![\\w$])`, "g");
  for (const m of current.matchAll(word)) {
    if (final.isCode(m.index!)) continue;
    findings.push(
      finding("mention", m.index!, "mentioned in a comment or string"),
    );
  }
  findings.sort((a, b) => a.line - b.line);
  return { source: current, rewrites, findings };
}

// --------------------------------------------------------------------- CLI --

const SKIPPED_DIRS = new Set(["node_modules", "target", "dist", "vendor"]);

function collectFiles(path: string, into: string[]): void {
  if (!statSync(path).isDirectory()) {
    into.push(path);
    return;
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name)) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) collectFiles(child, into);
    else if (entry.name.endsWith(".test.ts")) into.push(child);
  }
}

interface FileReport extends ConversionResult {
  path: string;
  changed: boolean;
}

function formatReport(reports: FileReport[], write: boolean): string {
  const lines: string[] = [];
  const changed = reports.filter((r) => r.changed).length;
  lines.push(
    `deno-test-dialect: ${reports.length} files scanned, ${changed} ` +
      `${write ? "changed" : "would change"}${write ? "" : " (dry run)"}`,
  );
  const byRule = new Map<string, number>();
  for (const report of reports) {
    for (const [rule, n] of report.rewrites) {
      byRule.set(rule, (byRule.get(rule) ?? 0) + n);
    }
  }
  lines.push("", "rewrites by rule:");
  for (const rule of RULES) {
    const n = byRule.get(rule.id);
    if (n) lines.push(`  ${rule.id.padEnd(26)} ${n}`);
  }
  const dirs = new Map<string, number[]>();
  for (const report of reports) {
    const row = dirs.get(dirname(report.path)) ?? [0, 0, 0, 0, 0, 0];
    row[0]++;
    if (report.changed) row[1]++;
    for (const n of report.rewrites.values()) row[2] += n;
    for (const finding of report.findings) {
      if (finding.kind === "hand-review") row[3]++;
      else if (finding.kind === "unconverted") row[4]++;
      else row[5]++;
    }
    dirs.set(dirname(report.path), row);
  }
  lines.push(
    "",
    "by directory: files, changed, rewrites, hand-review, unconverted, mentions",
  );
  for (const [dir, row] of [...dirs].sort(([a], [b]) => a < b ? -1 : 1)) {
    lines.push(
      `  ${dir.padEnd(48)} ${row.map((n) => String(n).padStart(5)).join(" ")}`,
    );
  }
  for (const kind of ["hand-review", "unconverted", "mention"] as const) {
    const rows = reports.flatMap((report) =>
      report.findings.filter((f) => f.kind === kind).map((f) =>
        `  ${report.path}:${write ? f.line : f.originalLine}  ${
          f.flag ? `[${f.flag}] ` : ""
        }${f.message}`
      )
    );
    lines.push("", `${kind} (${rows.length}):`, ...rows);
  }
  return lines.join("\n");
}

function main(args: string[]): number {
  const write = args.includes("--write");
  const json = args.includes("--json");
  const paths = args.filter((arg) => !arg.startsWith("--"));
  if (paths.length === 0) {
    console.error(
      "usage: deno-test-dialect.ts [--write] [--json] <file-or-directory>...",
    );
    return 2;
  }
  const files: string[] = [];
  for (const path of paths) collectFiles(path, files);
  const reports: FileReport[] = [];
  for (const file of files.sort()) {
    const before = readFileSync(file, "utf8");
    const result = convertSource(before);
    const changed = result.source !== before;
    if (write && changed) writeFileSync(file, result.source);
    reports.push({ ...result, path: relative(process.cwd(), file), changed });
  }
  if (json) {
    console.log(JSON.stringify(
      reports.map((r) => ({
        path: r.path,
        changed: r.changed,
        rewrites: Object.fromEntries(r.rewrites),
        findings: r.findings,
      })),
      null,
      2,
    ));
  } else {
    console.log(formatReport(reports, write));
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
