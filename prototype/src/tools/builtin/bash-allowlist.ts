/**
 * The read-only bash allowlist: which `bash` calls run without a per-call
 * approval (BIT-707, the interim until a sandbox decides by boundary).
 *
 * This is the one declared exception to "permissions ignore model-supplied
 * arguments" (README Section 1): it reads the bash `command` string, and only
 * to decide whether the call may skip the prompt. It fails closed. The
 * command is lexed by a small hand-written tokenizer that accepts a narrow
 * subset of POSIX shell, and anything outside that subset, any command or
 * option not named here, and any path that leaves the workspace means "ask".
 * A wrong answer here can only ever cost a prompt, never skip one.
 *
 * Accepted shape: segments joined by `&&` or `;`. A segment is one simple
 * command, optionally `2>&1`, optionally one `| head` or `| tail` that takes
 * only a line count. Each command, and each git subcommand, accepts only the
 * options named in its `OptionSpec`; a value that names a file is checked
 * like an operand, whether attached (`-fFILE`) or the next word. `cd <dir inside the workspace>` may lead a segment
 * followed by `&&`, and `cd "$PWD"` is accepted as the no-op models write.
 *
 * Lexing: single quotes are literal; double quotes are literal too, but any
 * `$`, backtick, backslash or `!` inside them fails the lex (except the
 * exact word `"$PWD"`). A backslash outside quotes fails: there are no
 * escapes. Every character must be printable ASCII, which also rules out
 * unicode lookalike operators. Quoted and unquoted parts join into one word.
 */

import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isWithinRoot } from "./file-access.ts";

/** Longer commands always ask: an approver should read what runs. */
export const MAX_ALLOWLIST_COMMAND_LENGTH = 2_000;
const MAX_SEGMENTS = 16;

export type BashClassification =
  | { allow: true }
  | { allow: false; why: string };

const ask = (why: string): BashClassification => ({ allow: false, why });

// ── Lexer ────────────────────────────────────────────────────────────────────

type Operator = "&&" | ";" | "|" | "2>&1";
type Token =
  | { kind: "word"; value: string }
  | { kind: "pwd" }
  | { kind: "op"; value: Operator };

// Unquoted characters that would make bash do something other than take them
// literally (expansion, redirection, grouping, globbing, history, comments).
const UNQUOTED_FORBIDDEN = new Set("<>()`\\*?[]{}!#$\"'");
const DOUBLE_QUOTED_FORBIDDEN = new Set("$`\\!");
const BOUNDARY = new Set([" ", "|", ";", "&"]);

function isPrintableAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

function atBoundary(command: string, index: number): boolean {
  return index >= command.length || BOUNDARY.has(command[index]);
}

function lex(command: string): Token[] | string {
  const tokens: Token[] = [];
  let word: string | null = null;
  const flush = () => {
    if (word !== null) tokens.push({ kind: "word", value: word });
    word = null;
  };

  let i = 0;
  while (i < command.length) {
    const c = command[i];
    if (c === " ") {
      flush();
      i++;
      continue;
    }
    if (word === null && command.startsWith("2>&1", i) && atBoundary(command, i + 4)) {
      tokens.push({ kind: "op", value: "2>&1" });
      i += 4;
      continue;
    }
    if (c === "&") {
      if (command[i + 1] !== "&") return "a background `&`";
      flush();
      tokens.push({ kind: "op", value: "&&" });
      i += 2;
      continue;
    }
    if (c === "|") {
      if (command[i + 1] === "|") return "an `||` chain";
      flush();
      tokens.push({ kind: "op", value: "|" });
      i++;
      continue;
    }
    if (c === ";") {
      flush();
      tokens.push({ kind: "op", value: ";" });
      i++;
      continue;
    }
    // The exact word `$PWD` or `"$PWD"`: the directory bash started in.
    const pwd = word === null
      ? ["$PWD", '"$PWD"'].find((form) =>
        command.startsWith(form, i) && atBoundary(command, i + form.length)
      )
      : undefined;
    if (pwd !== undefined) {
      tokens.push({ kind: "pwd" });
      i += pwd.length;
      continue;
    }
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) return "an unterminated quote";
      word = (word ?? "") + command.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      const end = command.indexOf('"', i + 1);
      if (end === -1) return "an unterminated quote";
      const inner = command.slice(i + 1, end);
      for (const ch of inner) {
        if (DOUBLE_QUOTED_FORBIDDEN.has(ch)) {
          return "an expansion or escape inside double quotes";
        }
      }
      word = (word ?? "") + inner;
      i = end + 1;
      continue;
    }
    if (UNQUOTED_FORBIDDEN.has(c)) return `the shell character \`${c}\``;
    // Tilde expansion happens at a word's start and after `=` or `:`.
    if (c === "~") {
      const prev = word === null ? "" : word.at(-1);
      if (word === null || prev === "=" || prev === ":") {
        return "a `~` home-directory path";
      }
    }
    word = (word ?? "") + c;
    i++;
  }
  flush();
  return tokens;
}

// ── Segments ─────────────────────────────────────────────────────────────────

interface Segment {
  words: Token[];
  mergesStderr: boolean;
  pipe: string[] | null;
  /** The operator after this segment, or null at the end. */
  next: "&&" | ";" | null;
}

function segments(tokens: Token[]): Segment[] | string {
  const out: Segment[] = [];
  let i = 0;
  while (i < tokens.length) {
    const words: Token[] = [];
    while (i < tokens.length && tokens[i].kind !== "op") words.push(tokens[i++]);
    if (words.length === 0) return "an empty command in the chain";
    let mergesStderr = false;
    let pipe: string[] | null = null;
    const at = () => tokens[i];
    if (at()?.kind === "op" && (at() as { value: Operator }).value === "2>&1") {
      mergesStderr = true;
      i++;
    }
    if (at()?.kind === "op" && (at() as { value: Operator }).value === "|") {
      i++;
      pipe = [];
      while (i < tokens.length && tokens[i].kind === "word") {
        pipe.push((tokens[i++] as { value: string }).value);
      }
      if (pipe.length === 0) return "an empty pipeline stage";
    }
    const sep = at();
    if (sep === undefined) {
      out.push({ words, mergesStderr, pipe, next: null });
      break;
    }
    if (sep.kind !== "op" || (sep.value !== "&&" && sep.value !== ";")) {
      return "a redirection or pipe outside the accepted shape";
    }
    i++;
    if (i >= tokens.length) return "a trailing operator";
    out.push({ words, mergesStderr, pipe, next: sep.value });
  }
  if (out.length > MAX_SEGMENTS) return "too many chained commands";
  return out;
}

// ── Paths ────────────────────────────────────────────────────────────────────

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where `path`, taken relative to the real directory `cwd`, resolves as the
 * kernel resolves it: segment by segment, following each existing symlink
 * before the next segment, so `link/..` is the parent of the link's target,
 * not `cwd`. Collapsing `..` lexically first would let `escape/../x` pass as
 * an in-workspace path while the shell reads outside through `escape`. Past
 * the first segment that does not exist the rest is taken as written, since
 * nothing below a missing directory can be a symlink. Null when a link
 * cannot be resolved or a `..` follows a missing segment: the caller asks.
 */
export function resolveFollowingLinks(cwd: string, path: string): string | null {
  let current = isAbsolute(path) ? "/" : cwd;
  let resolved = true;
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (!resolved) return null;
      current = dirname(current);
      continue;
    }
    const next = join(current, segment);
    if (!resolved || !exists(next)) {
      current = next;
      resolved = false;
      continue;
    }
    try {
      current = realpathSync(next);
    } catch {
      return null; // a dangling or unreadable link
    }
  }
  return current;
}

/** Inside the workspace as the kernel resolves it, symlinks followed. */
function pathInside(rootReal: string, cwd: string, path: string): boolean {
  const real = resolveFollowingLinks(cwd, path);
  return real !== null && isWithinRoot(rootReal, real);
}

function looksLikePath(word: string): boolean {
  return word.startsWith("/") || word.startsWith(".") || word.includes("/");
}

/**
 * An operand (a file, a directory, a revision, a pattern) keeps the command
 * inside the workspace: one that looks like a path, or names something that
 * exists, must resolve inside it, symlinks followed.
 */
function operandInside(rootReal: string, cwd: string, word: string): boolean {
  if (looksLikePath(word) || exists(resolve(cwd, word))) {
    return pathInside(rootReal, cwd, word);
  }
  return true;
}

// ── Commands ─────────────────────────────────────────────────────────────────

/**
 * What an option's value may be: a count, free text (a pattern, a glob, a
 * format), a git format (free text that does not ask git to verify a
 * signature), or a path, which must stay inside the workspace.
 */
type ValueKind = "number" | "text" | "format" | "path";

/**
 * The options a command accepts. Anything not named here asks: an accepted
 * set rather than a denylist, so an option nobody reviewed can never skip the
 * prompt. Long options match exactly, so an abbreviation getopt would accept
 * (`--files0` for `--files0-from`) asks too.
 */
interface OptionSpec {
  /** Short flags that take no value, combinable as in `-la`. */
  flags?: string;
  /** Short options that take a value, attached (`-n5`) or as the next word. */
  values?: Readonly<Record<string, ValueKind>>;
  /** Long options that take no value; a listed `--x=y` matches whole. */
  longFlags?: readonly string[];
  /** Long options that take a value, as `--x=v` or as the next word. */
  longValues?: Readonly<Record<string, ValueKind>>;
  /** A bare count such as `-5` (head, tail, git log). */
  numericShort?: boolean;
}

const NUMBER = /^\+?\d+$/;

function valueAllowed(
  kind: ValueKind,
  value: string,
  cwd: string,
  rootReal: string,
): boolean {
  switch (kind) {
    case "number":
      return NUMBER.test(value);
    case "text":
      return true;
    case "format":
      // `%G?`, `%GS` and the other `%G` placeholders run gpg.
      return !value.includes("%G");
    case "path":
      return value !== "" && pathInside(rootReal, cwd, value);
  }
}

/** Check every word after the command name (or git subcommand). */
function argumentsAllowed(
  name: string,
  args: readonly string[],
  spec: OptionSpec,
  cwd: string,
  rootReal: string,
): string | null {
  let operandsOnly = false;
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (operandsOnly || word === "-" || !word.startsWith("-")) {
      if (!operandInside(rootReal, cwd, word)) return "a path outside the workspace";
      continue;
    }
    if (word === "--") {
      operandsOnly = true;
      continue;
    }
    const refused = `the ${name} option \`${word}\``;
    if (word.startsWith("--")) {
      if (spec.longFlags?.includes(word)) continue;
      const eq = word.indexOf("=");
      const option = eq === -1 ? word : word.slice(0, eq);
      const kind = spec.longValues?.[option];
      if (kind === undefined) return refused;
      const value = eq === -1 ? args[++i] : word.slice(eq + 1);
      if (value === undefined || !valueAllowed(kind, value, cwd, rootReal)) {
        return refused;
      }
      continue;
    }
    if (spec.numericShort === true && /^-\d+$/.test(word)) continue;
    // A cluster of short options: flags, then at most one that takes a value,
    // whose value is the rest of the word or the next word.
    for (let at = 1; at < word.length; at++) {
      const letter = word[at];
      if (spec.flags?.includes(letter)) continue;
      const kind = spec.values?.[letter];
      if (kind === undefined) return refused;
      const rest = word.slice(at + 1);
      const value = rest === "" ? args[++i] : rest;
      if (value === undefined || !valueAllowed(kind, value, cwd, rootReal)) {
        return refused;
      }
      break;
    }
  }
  return null;
}

const COMMAND_OPTIONS: Readonly<Record<string, OptionSpec>> = {
  ls: {
    flags: "laAhrtSR1dFp",
    longFlags: [
      "--all",
      "--almost-all",
      "--human-readable",
      "--reverse",
      "--recursive",
      "--directory",
      "--classify",
    ],
  },
  cat: {
    flags: "nbsAvetET",
    longFlags: ["--number", "--number-nonblank", "--squeeze-blank"],
  },
  head: {
    flags: "qv",
    values: { n: "number", c: "number" },
    longValues: { "--lines": "number", "--bytes": "number" },
    numericShort: true,
  },
  tail: {
    flags: "qv",
    values: { n: "number", c: "number" },
    longValues: { "--lines": "number", "--bytes": "number" },
    numericShort: true,
  },
  // No `--files0-from`: it reads file names from a file nothing checks.
  wc: {
    flags: "lwcmL",
    longFlags: ["--lines", "--words", "--bytes", "--chars", "--max-line-length"],
  },
  // No `-R`: it follows symlinks out of the workspace.
  grep: {
    flags: "iInrvwxcloLHhsqEFGPa",
    values: {
      e: "text",
      f: "path",
      A: "number",
      B: "number",
      C: "number",
      m: "number",
    },
    longFlags: [
      "--ignore-case",
      "--line-number",
      "--recursive",
      "--invert-match",
      "--word-regexp",
      "--line-regexp",
      "--count",
      "--files-with-matches",
      "--files-without-match",
      "--only-matching",
      "--with-filename",
      "--no-filename",
      "--no-messages",
      "--quiet",
      "--silent",
      "--extended-regexp",
      "--fixed-strings",
      "--basic-regexp",
      "--perl-regexp",
      "--text",
    ],
    longValues: {
      "--regexp": "text",
      "--file": "path",
      "--after-context": "number",
      "--before-context": "number",
      "--context": "number",
      "--max-count": "number",
      "--include": "text",
      "--exclude": "text",
      "--exclude-dir": "text",
      "--color": "text",
    },
  },
  // No `--pre`, `-z` or `-L`: they run a program, a decompressor, or follow
  // symlinks out of the workspace.
  rg: {
    flags: "inwvxclqFSUuHNo",
    values: {
      e: "text",
      f: "path",
      g: "text",
      t: "text",
      T: "text",
      A: "number",
      B: "number",
      C: "number",
      m: "number",
      d: "number",
    },
    longFlags: [
      "--files",
      "--line-number",
      "--no-line-number",
      "--ignore-case",
      "--smart-case",
      "--case-sensitive",
      "--word-regexp",
      "--line-regexp",
      "--invert-match",
      "--count",
      "--files-with-matches",
      "--files-without-match",
      "--only-matching",
      "--fixed-strings",
      "--hidden",
      "--no-ignore",
      "--heading",
      "--no-heading",
      "--with-filename",
      "--no-filename",
      "--multiline",
      "--json",
      "--vimgrep",
      "--column",
      "--trim",
      "--quiet",
      "--type-list",
    ],
    longValues: {
      "--regexp": "text",
      "--file": "path",
      "--glob": "text",
      "--iglob": "text",
      "--type": "text",
      "--type-not": "text",
      "--after-context": "number",
      "--before-context": "number",
      "--context": "number",
      "--max-count": "number",
      "--max-depth": "number",
      "--max-columns": "number",
      "--ignore-file": "path",
      "--sort": "text",
      "--color": "text",
    },
  },
};

// Options of the read-only git subcommands, again an accepted set. A git
// global option (`-c`, `-C`, `--git-dir`, `-p`) would come before the
// subcommand, which must be the first word, so none is accepted.
const DIFF_OUTPUT_FLAGS = [
  "--stat",
  "--shortstat",
  "--numstat",
  "--name-only",
  "--name-status",
  "--patch",
  "--raw",
  "--summary",
  "--no-color",
  "--color=never",
  "--no-ext-diff",
  "--no-textconv",
] as const;

const LOG_FORMATS = {
  "--format": "format",
  "--pretty": "format",
} as const;

const GIT_OPTIONS: Readonly<Record<string, OptionSpec>> = {
  status: {
    flags: "sb",
    longFlags: [
      "--short",
      "--branch",
      "--long",
      "--porcelain",
      "--porcelain=v1",
      "--porcelain=v2",
      "--show-stash",
      "--ahead-behind",
      "--no-ahead-behind",
    ],
  },
  diff: {
    flags: "pbw",
    values: { U: "number" },
    longFlags: [
      ...DIFF_OUTPUT_FLAGS,
      "--cached",
      "--staged",
      "--check",
      "--ignore-all-space",
      "--ignore-space-change",
      "--word-diff",
      "--minimal",
    ],
    longValues: { "--unified": "number", "--diff-filter": "text" },
  },
  log: {
    flags: "p",
    values: { n: "number" },
    longFlags: [
      ...DIFF_OUTPUT_FLAGS,
      "--oneline",
      "--graph",
      "--decorate",
      "--no-decorate",
      "--all",
      "--reverse",
      "--first-parent",
      "--no-merges",
      "--merges",
      "--follow",
      "--abbrev-commit",
      "--date-order",
    ],
    longValues: {
      ...LOG_FORMATS,
      "--max-count": "number",
      "--skip": "number",
      "--since": "text",
      "--until": "text",
      "--after": "text",
      "--before": "text",
      "--author": "text",
      "--grep": "text",
      "--date": "text",
    },
    numericShort: true,
  },
  show: {
    flags: "ps",
    longFlags: [...DIFF_OUTPUT_FLAGS, "--oneline", "--no-patch", "--abbrev-commit"],
    longValues: LOG_FORMATS,
  },
  "rev-parse": {
    longFlags: [
      "--abbrev-ref",
      "--git-dir",
      "--git-common-dir",
      "--show-toplevel",
      "--show-prefix",
      "--show-cdup",
      "--short",
      "--verify",
      "--is-inside-work-tree",
      "--symbolic-full-name",
    ],
  },
};

const SED_SCRIPT_PART = /^(\d+|\$)(,(\d+|\$))?p$/;

function sedAllowed(args: string[], cwd: string, rootReal: string): string | null {
  let quiet = false;
  const scripts: string[] = [];
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (word === "-n" || word === "--quiet" || word === "--silent") {
      quiet = true;
    } else if (word === "-e") {
      const script = args[++i];
      if (script === undefined) return "a `sed -e` without a script";
      scripts.push(script);
    } else if (word.startsWith("-")) {
      return `the sed option \`${word}\``;
    } else if (scripts.length === 0 && files.length === 0) {
      scripts.push(word);
    } else {
      files.push(word);
    }
  }
  if (!quiet) return "sed without `-n`";
  if (scripts.length === 0) return "sed without a script";
  for (const script of scripts) {
    const parts = script.split(";").map((part) => part.trim());
    if (!parts.every((part) => SED_SCRIPT_PART.test(part))) {
      return "a sed script other than line-range printing";
    }
  }
  for (const file of files) {
    if (!pathInside(rootReal, cwd, file)) return "a path outside the workspace";
  }
  return null;
}

function pipeAllowed(stage: string[]): boolean {
  const [name, ...rest] = stage;
  if (name !== "head" && name !== "tail") return false;
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i];
    if (/^-\d+$/.test(word) || /^-n\d+$/.test(word)) continue;
    if (word === "-n" && /^\d+$/.test(rest[i + 1] ?? "")) {
      i++;
      continue;
    }
    return false;
  }
  return true;
}

function commandAllowed(words: string[], cwd: string, rootReal: string): string | null {
  const [name, ...args] = words;
  if (name === "git") {
    const [sub, ...rest] = args;
    if (sub === "branch") {
      return rest.length === 1 && rest[0] === "--show-current"
        ? null
        : "a git branch call other than `--show-current`";
    }
    const spec = sub === undefined ? undefined : GIT_OPTIONS[sub];
    if (spec === undefined) {
      return "a git option or subcommand outside the read-only set";
    }
    return argumentsAllowed(`git ${sub}`, rest, spec, cwd, rootReal);
  }
  if (name === "sed") return sedAllowed(args, cwd, rootReal);
  const spec = COMMAND_OPTIONS[name];
  if (spec === undefined) return `the command \`${name}\``;
  return argumentsAllowed(name, args, spec, cwd, rootReal);
}

/**
 * The directory a `cd` lands in, or null when it may not be auto-approved.
 * bash's `cd` is logical: it applies `..` to the path as written before the
 * kernel follows any symlink, while every other command resolves physically.
 * So a `cd` is accepted only when the two agree, that is when no symlink is
 * involved: then the shell's directory and the one checked here stay the
 * same for every later segment. `cwd` is always physical (the executor
 * starts bash with PWD set to the real directory).
 */
function directoryInside(rootReal: string, cwd: string, path: string): string | null {
  const real = resolveFollowingLinks(cwd, path);
  if (real === null || !isWithinRoot(rootReal, real)) return null;
  if (real !== resolve(cwd, path)) return null;
  try {
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/**
 * Decide whether `command`, run by `bash -c` in `cwd`, may skip approval.
 * `rootReal` is the workspace root's real path, and `cwd` an absolute path
 * inside it.
 */
export function classifyReadOnlyBash(
  command: string,
  cwd: string,
  rootReal: string,
): BashClassification {
  if (command.length > MAX_ALLOWLIST_COMMAND_LENGTH) {
    return ask("the command is too long to auto-approve");
  }
  if (!isPrintableAscii(command)) {
    return ask("a character outside printable ASCII");
  }
  const tokens = lex(command.trim());
  if (typeof tokens === "string") return ask(tokens);
  if (tokens.length === 0) return ask("an empty command");
  const parsed = segments(tokens);
  if (typeof parsed === "string") return ask(parsed);

  let here = cwd;
  for (const segment of parsed) {
    const [head, ...rest] = segment.words;
    if (head.kind !== "word") return ask("`$PWD` outside `cd \"$PWD\"`");
    if (head.value === "cd") {
      if (rest.length !== 1 || segment.mergesStderr || segment.pipe !== null) {
        return ask("a cd other than `cd <dir> &&`");
      }
      if (segment.next === ";") return ask("a cd followed by `;` rather than `&&`");
      const target = rest[0];
      if (target.kind === "pwd") continue;
      if (target.kind !== "word" || target.value === "-") {
        return ask("a cd other than `cd <dir> &&`");
      }
      const next = directoryInside(rootReal, here, target.value);
      if (next === null) {
        return ask("a cd outside the workspace or through a symlink");
      }
      here = next;
      continue;
    }
    const words: string[] = [];
    for (const token of segment.words) {
      if (token.kind !== "word") return ask("`$PWD` outside `cd \"$PWD\"`");
      words.push(token.value);
    }
    const refused = commandAllowed(words, here, rootReal);
    if (refused !== null) return ask(refused);
    if (segment.pipe !== null && !pipeAllowed(segment.pipe)) {
      return ask("a pipe to something other than `head` or `tail` with a line count");
    }
  }
  return { allow: true };
}
