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
 * only a line count. `cd <dir inside the workspace>` may lead a segment
 * followed by `&&`, and `cd "$PWD"` is accepted as the no-op models write.
 *
 * Lexing: single quotes are literal; double quotes are literal too, but any
 * `$`, backtick, backslash or `!` inside them fails the lex (except the
 * exact word `"$PWD"`). A backslash outside quotes fails: there are no
 * escapes. Every character must be printable ASCII, which also rules out
 * unicode lookalike operators. Quoted and unquoted parts join into one word.
 */

import { lstatSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
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

/** Inside the workspace lexically and, when it exists, by its real path. */
function pathInside(rootReal: string, cwd: string, path: string): boolean {
  const abs = resolve(cwd, path);
  if (!isWithinRoot(rootReal, abs)) return false;
  if (!exists(abs)) return true;
  try {
    return isWithinRoot(rootReal, realpathSync(abs));
  } catch {
    return false; // a dangling or unreadable link
  }
}

function looksLikePath(word: string): boolean {
  return word.startsWith("/") || word.startsWith(".") || word.includes("/");
}

/** Every argument word must keep the command inside the workspace. */
function argumentInside(rootReal: string, cwd: string, word: string): boolean {
  let candidate = word;
  if (word.startsWith("--")) {
    const eq = word.indexOf("=");
    if (eq === -1) return true;
    candidate = word.slice(eq + 1);
  } else if (word.startsWith("-") && word.length > 1) {
    // A short option with an attached value is not worth parsing per tool.
    return !word.includes("/");
  }
  if (candidate === "") return true;
  if (looksLikePath(candidate) || exists(resolve(cwd, candidate))) {
    return pathInside(rootReal, cwd, candidate);
  }
  return true;
}

// ── Commands ─────────────────────────────────────────────────────────────────

interface OptionRules {
  /** Short-option letters refused anywhere in a cluster such as `-nz`. */
  deniedShort?: string;
  /** Long options refused, along with any abbreviation getopt would accept. */
  deniedLong?: readonly string[];
}

function optionDenied(word: string, rules: OptionRules): boolean {
  if (word === "--" || !word.startsWith("-") || word === "-") return false;
  if (word.startsWith("--")) {
    const name = word.split("=", 1)[0];
    return (rules.deniedLong ?? []).some((denied) =>
      name.startsWith(denied) || (name.length >= 3 && denied.startsWith(name))
    );
  }
  return [...word.slice(1)].some((ch) => (rules.deniedShort ?? "").includes(ch));
}

const GIT_SUBCOMMANDS = new Set(["status", "diff", "log", "show", "rev-parse"]);

// Options of the read-only git subcommands that write a file, run a
// configured program, or read outside the repository.
const GIT_DENIED_LONG = [
  "--output",
  "--ext-diff",
  "--textconv",
  "--show-signature",
  "--no-index",
] as const;

const COMMAND_OPTIONS: Record<string, OptionRules> = {
  ls: { deniedShort: "L", deniedLong: ["--dereference"] },
  cat: {},
  wc: {},
  head: {},
  tail: { deniedShort: "fF", deniedLong: ["--follow", "--retry", "--pid"] },
  grep: { deniedShort: "R", deniedLong: ["--dereference-recursive"] },
  rg: {
    deniedShort: "zL",
    deniedLong: ["--pre", "--search-zip", "--follow", "--hostname-bin"],
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
    const sub = args[0];
    if (sub === "branch") {
      return args.length === 2 && args[1] === "--show-current"
        ? null
        : "a git branch call other than `--show-current`";
    }
    if (sub === undefined || !GIT_SUBCOMMANDS.has(sub)) {
      return "a git option or subcommand outside the read-only set";
    }
    for (const word of args.slice(1)) {
      if (optionDenied(word, { deniedLong: GIT_DENIED_LONG })) {
        return `the git option \`${word}\``;
      }
      if (!argumentInside(rootReal, cwd, word)) return "a path outside the workspace";
    }
    return null;
  }
  if (name === "sed") return sedAllowed(args, cwd, rootReal);
  const rules = COMMAND_OPTIONS[name];
  if (rules === undefined) return `the command \`${name}\``;
  for (const word of args) {
    if (optionDenied(word, rules)) return `the ${name} option \`${word}\``;
    if (!argumentInside(rootReal, cwd, word)) return "a path outside the workspace";
  }
  return null;
}

function directoryInside(rootReal: string, cwd: string, path: string): string | null {
  const abs = resolve(cwd, path);
  if (!isWithinRoot(rootReal, abs)) return null;
  try {
    const real = realpathSync(abs);
    return isWithinRoot(rootReal, real) && statSync(real).isDirectory() ? real : null;
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
      if (next === null) return ask("a cd outside the workspace");
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
