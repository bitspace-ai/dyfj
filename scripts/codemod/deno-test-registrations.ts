// Test-registrations codemod (BIT-649): phase S3.2b of decision D32.
//
// Moves a test file's registrations onto `node:test`, so the lane runners
// route it to `node --test` (`prototype/scripts/test-files.ts`):
//
// - the host runtime's test function, `<host>.test(name, fn)`, becomes
//   `test(name, fn)`;
// - an `@std/testing/bdd` import becomes a `node:test` import, merged with
//   any existing one, with `beforeAll` -> `before` and `afterAll` -> `after`;
// - a bdd `describe`/`it` option bag `{ ignore: x }` becomes `{ skip: x }`;
// - `t.step(` becomes `t.test(` when `t` is a test function's context.
//
// It is a sibling of the dialect codemod (`deno-test-dialect.ts`), not an
// extension of it: that tool converts what runs inside registrations and
// leaves the registrations alone by design, and its fixtures pin that. This
// one reuses its scanner. A file converts whole or not at all: a file left
// with both registration styles fails lane discovery, so any shape the rules
// do not cover is flagged for hand conversion and the file is left as it is.
// Every rule is idempotent. Delete this tool once S3.2b is done.
//
// Like the runtime.neutral lane, this file is written to node: builtins and
// never names the host runtime's global in its own text.
//
// Usage (from the repository root):
//   deno run --allow-read=. --allow-write=. \
//     scripts/codemod/deno-test-registrations.ts \
//     [--write] [--json] <file-or-directory>...
// Without --write it is a dry run. A directory is searched for *.test.ts.
// Findings name lines in the file before conversion.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { codeMask } from "./deno-test-dialect.ts";

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
    id: "registration.test",
    from: "<host>.test(name, fn)",
    to: 'test(name, fn), with test imported from "node:test"',
  },
  {
    id: "registration.bdd-import",
    from: 'import { ... } from "@std/testing/bdd"',
    to: 'the same names from "node:test", merged with any existing import',
  },
  {
    id: "registration.hook-rename",
    from: "beforeAll / afterAll",
    to: "before / after",
  },
  {
    id: "registration.ignore",
    from: "describe / it option { ignore: x }",
    to: "{ skip: x }",
  },
  {
    id: "registration.step",
    from: "t.step( on a test function's context",
    to: "t.test(",
  },
];

/** Shapes left for hand conversion. Any one leaves its file unchanged. */
export const FLAGS = {
  "object-form":
    "the host's test function called with an options object, or a bdd " +
    "registration called with one; convert by hand",
  "test-options":
    "a registration option other than a bdd ignore, or a host test with an " +
    "options argument; convert by hand",
  "test-function":
    "the test function is not an inline function taking no parameter or one " +
    "plain context parameter; convert by hand",
  "context-use":
    "the test context is used other than for step; node's context differs, " +
    "so convert by hand",
  "registration-member":
    "a registration used other than as a direct call (a member such as " +
    ".only or .ignore, or passed as a value); convert by hand",
  "host-reference":
    "a reference to the host runtime's global other than its test function; " +
    "a file moving to node:test cannot keep it",
  "bdd-import-shape":
    "an @std/testing/bdd import that is not a plain named import of " +
    "describe, it and the four hooks; convert by hand",
  "name-collision":
    "the file already uses the name `test`, which the conversion imports; " +
    "convert by hand",
} as const;

export type Flag = keyof typeof FLAGS;

export interface Finding {
  kind: "hand-review" | "mention";
  flag?: Flag;
  /** 1-based line in the text before conversion. */
  line: number;
  message: string;
}

export interface ConversionResult {
  source: string;
  rewrites: Map<string, number>;
  findings: Finding[];
}

// ---------------------------------------------------------------- scanner --

const IDENT = /[\w$]/;
const IDENT_START = /[A-Za-z_$]/;
const SPACE = /\s/;
const OPENERS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

class Source {
  readonly text: string;
  readonly mask: Uint8Array;
  constructor(text: string) {
    this.text = text;
    this.mask = codeMask(text);
  }
  isCode(i: number): boolean {
    return this.mask[i] === 1;
  }
  /** The next code position at or after `pos` that is not space. */
  nextCode(pos: number): number {
    let j = pos;
    while (
      j < this.text.length && (!this.isCode(j) || SPACE.test(this.text[j]))
    ) {
      j++;
    }
    return j;
  }
  /** The previous code position before `pos` that is not space. */
  prevCode(pos: number): number {
    let j = pos - 1;
    while (j >= 0 && (!this.isCode(j) || SPACE.test(this.text[j]))) j--;
    return j;
  }
  lineOf(pos: number): number {
    let line = 1;
    for (let i = 0; i < pos; i++) if (this.text[i] === "\n") line++;
    return line;
  }
  /** The matching close of the bracket at `open`, or -1. */
  matchBracket(open: number): number {
    const stack: string[] = [];
    for (let i = open; i < this.text.length; i++) {
      if (!this.isCode(i)) continue;
      const c = this.text[i];
      if (c in OPENERS) stack.push(OPENERS[c]);
      else if (c === ")" || c === "]" || c === "}") {
        if (stack.pop() !== c) return -1;
        if (stack.length === 0) return i;
      }
    }
    return -1;
  }
  /** Code occurrences of the whole word `name`. */
  words(name: string, from = 0, to = this.text.length): number[] {
    const out: number[] = [];
    let at = this.text.indexOf(name, from);
    while (at >= 0 && at < to) {
      const end = at + name.length;
      if (
        this.isCode(at) && !IDENT.test(this.text[at - 1] ?? "") &&
        !IDENT.test(this.text[end] ?? "")
      ) {
        out.push(at);
      }
      at = this.text.indexOf(name, at + 1);
    }
    return out;
  }
  /** Whether the word at `pos` is reached through a member access. */
  isMember(pos: number): boolean {
    const prev = this.prevCode(pos);
    return prev >= 0 && this.text[prev] === "." &&
      this.text[prev - 1] !== ".";
  }
}

interface Span {
  start: number;
  end: number;
}

/** The top-level arguments between `open` and `close`, trimmed. */
function splitArgs(src: Source, open: number, close: number): Span[] {
  const args: Span[] = [];
  let start = open + 1;
  let depth = 0;
  const push = (end: number) => {
    let s = start;
    let e = end;
    while (s < e && (SPACE.test(src.text[s]) || src.mask[s] === 2)) s++;
    while (e > s && (SPACE.test(src.text[e - 1]) || src.mask[e - 1] === 2)) e--;
    if (e > s) args.push({ start: s, end: e });
  };
  for (let i = open + 1; i < close; i++) {
    if (!src.isCode(i)) continue;
    const c = src.text[i];
    if (c in OPENERS) depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      push(i);
      start = i + 1;
    }
  }
  push(close);
  return args;
}

interface InlineFunction {
  /** The parameter list's text, trimmed. */
  params: string;
  paramsStart: number;
  body: Span;
  usesFunctionKeyword: boolean;
}

/** The inline function an argument holds, or undefined for anything else. */
function inlineFunction(src: Source, arg: Span): InlineFunction | undefined {
  const text = src.text.slice(arg.start, arg.end);
  const asyncPrefix = /^async\b\s*/.exec(text)?.[0].length ?? 0;
  const rest = arg.start + asyncPrefix;
  const fnKeyword = /^function\b\s*\*?\s*[\w$]*\s*/.exec(
    src.text.slice(rest, arg.end),
  );
  if (fnKeyword !== null) {
    const open = rest + fnKeyword[0].length;
    if (src.text[open] !== "(") return undefined;
    const close = src.matchBracket(open);
    if (close < 0) return undefined;
    const brace = src.text.indexOf("{", close);
    if (brace < 0 || brace >= arg.end) return undefined;
    return {
      params: src.text.slice(open + 1, close).trim(),
      paramsStart: open + 1,
      body: { start: brace, end: arg.end },
      usesFunctionKeyword: true,
    };
  }
  if (src.text[rest] === "(") {
    const close = src.matchBracket(rest);
    if (close < 0) return undefined;
    const arrow = src.text.indexOf("=>", close);
    if (arrow < 0 || arrow >= arg.end) return undefined;
    const between = src.text.slice(close + 1, arrow).trim();
    // Only an optional return type annotation may stand between.
    if (between !== "" && !between.startsWith(":")) return undefined;
    return {
      params: src.text.slice(rest + 1, close).trim(),
      paramsStart: rest + 1,
      body: { start: arrow + 2, end: arg.end },
      usesFunctionKeyword: false,
    };
  }
  const single = /^([A-Za-z_$][\w$]*)\s*=>/.exec(src.text.slice(rest, arg.end));
  if (single !== null) {
    return {
      params: single[1],
      paramsStart: rest,
      body: { start: rest + single[0].length, end: arg.end },
      usesFunctionKeyword: false,
    };
  }
  return undefined;
}

const PLAIN_NAME = /^[A-Za-z_$][\w$]*$/;

/** The object literal's own keys, or undefined when it is not a plain one. */
function objectKeys(
  src: Source,
  arg: Span,
): { key: string; at: number }[] | undefined {
  if (
    src.text[arg.start] !== "{" || src.matchBracket(arg.start) !== arg.end - 1
  ) {
    return undefined;
  }
  const keys: { key: string; at: number }[] = [];
  for (const prop of splitArgs(src, arg.start, arg.end - 1)) {
    const match = /^([A-Za-z_$][\w$]*)\s*:/.exec(
      src.text.slice(prop.start, prop.end),
    );
    if (match === null) return undefined;
    keys.push({ key: match[1], at: prop.start });
  }
  return keys;
}

// ----------------------------------------------------------------- imports --

interface ImportSpecifier {
  imported: string;
  local: string;
  type: boolean;
}

interface NamedImport extends Span {
  specifiers: ImportSpecifier[];
}

const BDD_SPECIFIER = /^(?:jsr:)?@std\/testing(?:@[^/]+)?\/bdd$/;
const BDD_NAMES = new Set([
  "describe",
  "it",
  "beforeAll",
  "afterAll",
  "beforeEach",
  "afterEach",
]);
const HOOK_RENAMES: Record<string, string> = {
  beforeAll: "before",
  afterAll: "after",
};
const ANY_IMPORT =
  /\bimport\s+(type\s+)?([^;'"]*?)\s*from\s*(["'])([^"']+)\3\s*;?[ \t]*/g;

interface ParsedImport extends Span {
  typeOnly: boolean;
  clause: string;
  specifier: string;
}

function parseImports(src: Source): ParsedImport[] {
  const out: ParsedImport[] = [];
  for (const match of src.text.matchAll(ANY_IMPORT)) {
    const start = match.index;
    if (!src.isCode(start)) continue;
    out.push({
      start,
      end: start + match[0].length,
      typeOnly: match[1] !== undefined,
      clause: match[2],
      specifier: match[4],
    });
  }
  return out;
}

/** The named specifiers of `clause`, or undefined when it has other parts. */
function namedSpecifiers(clause: string): ImportSpecifier[] | undefined {
  const braces = /^\{([^}]*)\}$/.exec(clause.trim());
  if (braces === null) return undefined;
  const out: ImportSpecifier[] = [];
  for (const part of braces[1].split(",")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const match = /^(type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(trimmed);
    if (match === null) return undefined;
    out.push({
      imported: match[2],
      local: match[3] ?? match[2],
      type: match[1] !== undefined,
    });
  }
  return out;
}

function renderSpecifier(spec: ImportSpecifier): string {
  const name = spec.imported === spec.local
    ? spec.imported
    : `${spec.imported} as ${spec.local}`;
  return spec.type ? `type ${name}` : name;
}

function renderNodeTestImport(specs: ImportSpecifier[]): string {
  const sorted = [...specs].sort((a, b) =>
    a.imported.localeCompare(b.imported)
  );
  return `import { ${
    sorted.map(renderSpecifier).join(", ")
  } } from "node:test";`;
}

// --------------------------------------------------------------- convert --

interface Edit extends Span {
  text: string;
}

const REGISTRATION_KINDS: Record<string, "suite" | "test" | "hook"> = {
  describe: "suite",
  it: "test",
  beforeAll: "hook",
  afterAll: "hook",
  beforeEach: "hook",
  afterEach: "hook",
};

export function convertSource(text: string): ConversionResult {
  const src = new Source(text);
  const findings: Finding[] = [];
  const rewrites = new Map<string, number>();
  const edits: Edit[] = [];
  const count = (rule: string) =>
    rewrites.set(rule, (rewrites.get(rule) ?? 0) + 1);
  const flag = (pos: number, f: Flag, detail?: string) =>
    findings.push({
      kind: "hand-review",
      flag: f,
      line: src.lineOf(pos),
      message: detail === undefined ? FLAGS[f] : `${detail}: ${FLAGS[f]}`,
    });

  const imports = parseImports(src);
  const insideImport = (pos: number) =>
    imports.some((imp) => pos >= imp.start && pos < imp.end);

  // The bdd imports, and the local names they bind.
  const bddImports: NamedImport[] = [];
  const bddLocals = new Map<string, string>();
  for (const imp of imports) {
    if (!BDD_SPECIFIER.test(imp.specifier)) continue;
    const specs = imp.typeOnly ? undefined : namedSpecifiers(imp.clause);
    if (
      specs === undefined ||
      specs.some((spec) => spec.type || !BDD_NAMES.has(spec.imported))
    ) {
      flag(imp.start, "bdd-import-shape");
      continue;
    }
    bddImports.push({ start: imp.start, end: imp.end, specifiers: specs });
    for (const spec of specs) bddLocals.set(spec.local, spec.imported);
  }

  // The existing value import of node:test, if there is one to merge into.
  const nodeTestImport = imports.find((imp) =>
    imp.specifier === "node:test" && !imp.typeOnly &&
    namedSpecifiers(imp.clause) !== undefined
  );
  const nodeTestSpecs = nodeTestImport === undefined
    ? []
    : namedSpecifiers(nodeTestImport.clause)!;

  // Test functions whose first parameter is a context, collected for the
  // step rule once registrations are read.
  const contexts: { fn: InlineFunction; pos: number }[] = [];
  const readTestFunction = (
    arg: Span,
    takesContext: boolean,
    pos: number,
  ): void => {
    const fn = inlineFunction(src, arg);
    if (fn === undefined) {
      flag(pos, "test-function");
      return;
    }
    if (fn.params === "") return;
    if (!takesContext || !PLAIN_NAME.test(fn.params)) {
      flag(pos, "test-function");
      return;
    }
    contexts.push({ fn, pos });
  };

  // The host's test function, and any other reference to the host.
  let hostTests = 0;
  for (const at of src.words(HOST)) {
    if (src.isMember(at)) continue;
    const dot = src.nextCode(at + HOST.length);
    const member = /^\.\s*test\b/.exec(src.text.slice(dot));
    if (src.text[dot] !== "." || member === null) {
      flag(at, "host-reference");
      continue;
    }
    const memberEnd = dot + member[0].length;
    const open = src.nextCode(memberEnd);
    if (src.text[open] !== "(") {
      flag(at, "registration-member", `${HOST}.test`);
      continue;
    }
    const close = src.matchBracket(open);
    if (close < 0) {
      flag(at, "test-function");
      continue;
    }
    const args = splitArgs(src, open, close);
    if (args.length > 0 && src.text[args[0].start] === "{") {
      flag(at, "object-form");
      continue;
    }
    if (args.length !== 2) {
      flag(at, args.length === 3 ? "test-options" : "test-function");
      continue;
    }
    readTestFunction(args[1], true, at);
    edits.push({ start: at, end: memberEnd, text: "test" });
    hostTests++;
  }

  // bdd registrations, by their local names.
  const hookCalls: { at: number; local: string }[] = [];
  for (const [local, imported] of bddLocals) {
    const kind = REGISTRATION_KINDS[imported];
    for (const at of src.words(local)) {
      if (insideImport(at) || src.isMember(at)) continue;
      const open = src.nextCode(at + local.length);
      if (src.text[open] !== "(") {
        flag(at, "registration-member", local);
        continue;
      }
      const close = src.matchBracket(open);
      if (close < 0) {
        flag(at, "test-function", local);
        continue;
      }
      const args = splitArgs(src, open, close);
      if (args.length > 0 && src.text[args[0].start] === "{") {
        flag(at, "object-form", local);
        continue;
      }
      if (kind === "hook") {
        if (args.length !== 1) flag(at, "test-function", local);
        else readTestFunction(args[0], false, at);
        if (imported in HOOK_RENAMES) hookCalls.push({ at, local });
        continue;
      }
      if (args.length === 3) {
        const keys = objectKeys(src, args[1]);
        if (keys === undefined || keys.some(({ key }) => key !== "ignore")) {
          flag(at, "test-options", local);
          continue;
        }
        for (const { at: keyAt } of keys) {
          edits.push({
            start: keyAt,
            end: keyAt + "ignore".length,
            text: "skip",
          });
          count("registration.ignore");
        }
      } else if (args.length !== 2) {
        flag(at, "test-function", local);
        continue;
      }
      readTestFunction(args[args.length - 1], kind === "test", at);
    }
  }

  // A function written with `function` sees bdd's shared `this`; node's
  // registrations do not provide one.
  for (const { fn, pos } of contexts) {
    if (
      fn.usesFunctionKeyword &&
      src.words("this", fn.body.start, fn.body.end).length > 0
    ) {
      flag(pos, "context-use");
    }
  }

  // The step rule: every use of a context must be `<context>.step(`. A
  // step's own function takes a context in turn.
  const declared = new Set<number>();
  const stepped = new Set<number>();
  const pending = [...contexts];
  const seen = new Set<number>();
  while (pending.length > 0) {
    const { fn, pos } = pending.shift()!;
    if (seen.has(fn.paramsStart)) continue;
    seen.add(fn.paramsStart);
    declared.add(fn.paramsStart);
    for (const at of src.words(fn.params, fn.body.start, fn.body.end)) {
      if (declared.has(at) || src.isMember(at)) continue;
      const dot = src.nextCode(at + fn.params.length);
      const step = /^\.\s*step\b/.exec(src.text.slice(dot));
      const open = step === null ? -1 : src.nextCode(dot + step[0].length);
      if (src.text[dot] !== "." || step === null || src.text[open] !== "(") {
        // A nested function's own parameter of the same name is declared,
        // not used; it is read when its step is.
        const ahead = src.text.slice(at + fn.params.length).trimStart();
        if (/^(?:\)\s*(?::[^=]*)?=>|=>)/.test(ahead)) continue;
        flag(at, "context-use", fn.params);
        continue;
      }
      // A nested step's context is in its parent's body too: read it once.
      if (stepped.has(at)) continue;
      stepped.add(at);
      const name = dot + step[0].length - "step".length;
      edits.push({ start: name, end: name + "step".length, text: "test" });
      count("registration.step");
      const close = src.matchBracket(open);
      const args = close < 0 ? [] : splitArgs(src, open, close);
      if (args.length !== 2) {
        flag(at, "test-function", `${fn.params}.step`);
        continue;
      }
      const inner = inlineFunction(src, args[1]);
      if (inner === undefined) {
        flag(at, "test-function", `${fn.params}.step`);
      } else if (inner.params !== "") {
        if (!PLAIN_NAME.test(inner.params)) {
          flag(at, "test-function", `${fn.params}.step`);
        } else {
          declared.add(inner.paramsStart);
          pending.push({ fn: inner, pos: at });
        }
      }
    }
  }

  // Imports. `test` must not already name something else in the file.
  const nodeSpecs = nodeTestSpecs.map((spec) => ({ ...spec }));
  const binds = (local: string) => nodeSpecs.some((s) => s.local === local);
  if (hostTests > 0 && !binds("test")) {
    if (
      src.words("test").some((at) => !src.isMember(at) && !insideImport(at))
    ) {
      flag(
        src.words("test").find((at) => !src.isMember(at))!,
        "name-collision",
      );
    } else {
      nodeSpecs.push({ imported: "test", local: "test", type: false });
    }
  }
  findings.sort((a, b) => a.line - b.line);
  if (findings.length > 0) {
    return { source: text, rewrites: new Map(), findings };
  }
  for (let i = 0; i < hostTests; i++) count("registration.test");

  for (const imp of bddImports) {
    count("registration.bdd-import");
    for (const spec of imp.specifiers) {
      const renamed = HOOK_RENAMES[spec.imported];
      if (renamed === undefined || spec.local !== spec.imported) {
        nodeSpecs.push({ ...spec, imported: renamed ?? spec.imported });
        continue;
      }
      // The new name is already used in the file (often a local variable):
      // keep the old local name as an alias rather than prove scopes.
      const taken = src.words(renamed).some((at) =>
        !src.isMember(at) && !insideImport(at)
      );
      if (taken) {
        nodeSpecs.push({ imported: renamed, local: spec.local, type: false });
        findings.push({
          kind: "mention",
          line: src.lineOf(imp.start),
          message: `${spec.local} kept as a local alias of node:test's ` +
            `${renamed}: the file already uses the name ${renamed}`,
        });
        continue;
      }
      nodeSpecs.push({ imported: renamed, local: renamed, type: false });
      for (const call of hookCalls) {
        if (call.local !== spec.local) continue;
        edits.push({
          start: call.at,
          end: call.at + call.local.length,
          text: renamed,
        });
        count("registration.hook-rename");
      }
    }
  }

  const changed = edits.length > 0 || bddImports.length > 0;
  if (!changed) return { source: text, rewrites, findings };

  // One node:test import: the existing one, else the first bdd import's
  // place, else after the last node: import, else before the first import.
  const rendered = renderNodeTestImport(nodeSpecs);
  const removeLine = (span: Span): Edit => {
    const end = text[span.end] === "\n" ? span.end + 1 : span.end;
    return { start: span.start, end, text: "" };
  };
  if (nodeTestImport !== undefined) {
    edits.push({
      start: nodeTestImport.start,
      end: nodeTestImport.end,
      text: rendered,
    });
    for (const imp of bddImports) edits.push(removeLine(imp));
  } else if (bddImports.length > 0) {
    const [first, ...others] = bddImports;
    edits.push({ start: first.start, end: first.end, text: rendered });
    for (const imp of others) edits.push(removeLine(imp));
  } else {
    const nodeImports = imports.filter((imp) =>
      imp.specifier.startsWith("node:")
    );
    if (nodeImports.length > 0) {
      const last = nodeImports[nodeImports.length - 1];
      const end = text[last.end] === "\n" ? last.end + 1 : last.end;
      edits.push({ start: end, end, text: `${rendered}\n` });
    } else if (imports.length > 0) {
      const first = imports[0].start;
      edits.push({ start: first, end: first, text: `${rendered}\n` });
    } else {
      edits.push({ start: 0, end: 0, text: `${rendered}\n\n` });
    }
  }

  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  for (const edit of edits) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return { source: out, rewrites, findings };
}

// -------------------------------------------------------------------- cli --

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

export function formatReport(reports: FileReport[], write: boolean): string {
  const lines: string[] = [];
  const changed = reports.filter((r) => r.changed).length;
  lines.push(
    `deno-test-registrations: ${reports.length} files scanned, ${changed} ` +
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
    lines.push(`  ${rule.id.padEnd(26)} ${byRule.get(rule.id) ?? 0}`);
  }
  lines.push("", "by file: rewrites per rule, findings");
  for (const report of reports) {
    const parts = [...report.rewrites].map(([rule, n]) =>
      `${rule.replace("registration.", "")}=${n}`
    );
    const flags = report.findings.filter((f) => f.kind === "hand-review");
    if (flags.length > 0) parts.push(`hand-review=${flags.length}`);
    if (parts.length === 0) parts.push("no registrations of its own");
    lines.push(`  ${report.path}  ${parts.join(" ")}`);
  }
  for (const kind of ["hand-review", "mention"] as const) {
    const rows = reports.flatMap((report) =>
      report.findings.filter((f) => f.kind === kind).map((f) =>
        `  ${report.path}:${f.line}  ${
          f.flag ? `[${f.flag}] ` : ""
        }${f.message}`
      )
    );
    lines.push("", `${kind} (${rows.length}):`, ...rows);
  }
  return lines.join("\n");
}

const USAGE =
  "usage: deno-test-registrations.ts [--write] [--json] <file-or-directory>...";

/**
 * The command line: the two flags and at least one path. An unknown option
 * is an error, so a mistyped `--write` cannot fall back to a dry run.
 */
export function parseCliArgs(
  args: readonly string[],
): { write: boolean; json: boolean; paths: string[] } {
  const unknown = args.filter((arg) =>
    arg.startsWith("-") && arg !== "--write" && arg !== "--json"
  );
  if (unknown.length > 0) {
    throw new Error(`unknown option ${unknown.join(", ")}; ${USAGE}`);
  }
  const paths = args.filter((arg) => !arg.startsWith("-"));
  if (paths.length === 0) throw new Error(USAGE);
  return {
    write: args.includes("--write"),
    json: args.includes("--json"),
    paths,
  };
}

function main(args: string[]): number {
  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs(args);
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }
  const { write, json, paths } = parsed;
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
