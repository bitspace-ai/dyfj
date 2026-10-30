/**
 * The `[publish]` table: the operator's own commands for the host-side
 * `publish` tool (BIT-786).
 *
 *   [publish]
 *   pre_gate = ["./scripts/pre-gate", "--range", "{range}"]
 *   gate     = ["./scripts/gate", "--range", "{range}", "--report", "{report}"]
 *
 * Every command is an ARGV ARRAY, never a shell string: the tool builds the
 * argv itself and substitutes the placeholders below into single elements, so
 * no operator command is ever parsed for `;`, `&&` or quoting. `argv[0]` must
 * be a literal (no placeholder chooses the program), and a shell, `env` before
 * a shell, or a runtime that evaluates text (`node`, `python`, `perl`, `ruby`)
 * is refused by name, and both checks run again on the filled argv. These are
 * name checks on basenames: they catch a shell string written where an argv
 * belongs, not every program that can run one (`busybox sh` passes).
 *
 * Nothing here ships a default that names a private path: an absent `[publish]`
 * table means no publish tool at all. The one defaulted value is the report
 * path, which is a scratch file the tool creates itself.
 *
 * This module is parsing and validation only. Running a command is the tool's
 * business (`tools/builtin/publish.ts`), and the placeholders it may fill are
 * declared here so the two cannot drift.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { processEnv } from "./env.ts";
import { readTextFile as defaultReadTextFile } from "./read-text-file.ts";
import {
  configFilePath,
  configLabel,
  defaultParseToml,
  type LoadConfigDeps,
  readConfigFile,
} from "./toml.ts";

/**
 * The placeholders a command element may carry. Each is filled from a value
 * the tool resolves host-side, except `{issue}`, which is the operator-facing
 * tracker identifier the model may supply.
 */
export const PUBLISH_PLACEHOLDERS = [
  "repo",
  "branch",
  "head",
  "range",
  "issue",
  "implementer",
  "report",
  "ticket",
] as const;

export type PublishPlaceholder = typeof PUBLISH_PLACEHOLDERS[number];

/** The values one substitution fills; every placeholder must be present. */
export type PublishValues = Readonly<Record<PublishPlaceholder, string>>;

/** One configured command: the argv template as the operator wrote it. */
export type PublishArgv = readonly string[];

export interface PublishConfig {
  /** Run before the gate; its failure stops the tool without gating. */
  preGate: PublishArgv;
  /** The gate. Exit status only: 0 passes, anything else stops. */
  gate: PublishArgv;
  /**
   * Where the gate's combined output is written and read back. The template
   * must carry `{ticket}` in its final component and must not name
   * `{report}`.
   */
  reportPath: string;
  /**
   * The gate's deadline. The gate takes 10-30 minutes by hand, so the default
   * is generous: a gate that outlives it is stopped and reported as a timeout.
   */
  gateTimeoutMs: number;
  /**
   * How long a started ticket stays usable. A ticket past its TTL reports
   * `expired`; a head change invalidates it sooner.
   */
  ticketTtlMs: number;
}

/** Default gate deadline: 40 minutes, well past a hand run's 10-30. */
export const DEFAULT_GATE_TIMEOUT_MS = 40 * 60 * 1_000;
/** Default ticket lifetime: 24 hours. */
export const DEFAULT_TICKET_TTL_MS = 24 * 60 * 60 * 1_000;

/** Bounds on the two durations, so a typo cannot mean "never" or "forever". */
export const MIN_GATE_TIMEOUT_MS = 1_000;
export const MAX_GATE_TIMEOUT_MS = 4 * 60 * 60 * 1_000;
export const MIN_TICKET_TTL_MS = 60 * 1_000;
export const MAX_TICKET_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

/** Elements one command may have, and the bytes one command may carry. */
export const MAX_ARGV_ELEMENTS = 32;
export const MAX_ARGV_BYTES = 8_192;
/** Elements one placeholder-substituted argument may carry after substitution. */
export const MAX_ELEMENT_BYTES = 4_096;

/**
 * Programs refused as `argv[0]`: anything that would turn an argv back into a
 * program built from a string. A shell by name, and the runtimes whose whole
 * purpose is to evaluate text (`node -e`, `python -c`, `perl -e`, ...).
 */
export const REFUSED_PROGRAMS: readonly string[] = Object.freeze([
  "env",
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "mksh",
  "ash",
  "fish",
  "csh",
  "tcsh",
  "pwsh",
  "powershell",
  "cmd",
  "cmd.exe",
  "node",
  "nodejs",
  "perl",
  "ruby",
]);

/**
 * The programs `env` must not lead to: `env sh -c ...` is the shell string the
 * array was meant to prevent, one program removed.
 */
export const SHELL_PROGRAMS: readonly string[] = Object.freeze([
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "mksh",
  "ash",
  "fish",
  "csh",
  "tcsh",
  "pwsh",
  "powershell",
  "cmd",
  "cmd.exe",
]);

/** A python launcher: `python`, `python3`, `python3.12`, `python3-config`? no. */
const PYTHON_PROGRAM = /^python(?:\d+(?:\.\d+)*)?$/u;

const PUBLISH_KEYS: ReadonlySet<string> = new Set([
  "pre_gate",
  "gate",
  "report_path",
  "gate_timeout_ms",
  "ticket_ttl_ms",
]);

const PLACEHOLDER_REF = /\{([^{}]*)\}/gu;

/** The basename of an argv element, lowercased, for the program refusals. */
function programName(element: string): string {
  const base = element.split(/[\\/]/u).pop() ?? element;
  return base.toLowerCase();
}

/** True when `element` is a program an argv must not start with. */
function isRefusedProgram(element: string): boolean {
  const name = programName(element);
  return REFUSED_PROGRAMS.includes(name) || PYTHON_PROGRAM.test(name);
}

/**
 * `env` runs the program its first non-option argument names, which is how a
 * refused program gets back in. Refuse `env` anywhere before a shell.
 */
function refusedEnvChain(elements: readonly string[]): string | null {
  const at = elements.findIndex((element) => programName(element) === "env");
  if (at < 0) return null;
  const leadsToShell = elements
    .slice(at + 1)
    .some((element) => SHELL_PROGRAMS.includes(programName(element)));
  return leadsToShell ? `publish argument ${at}` : null;
}

/** True when `element` starts with a dash, i.e. is a flag by shape. */
function isFlagShaped(element: string): boolean {
  return element.startsWith("-");
}

/**
 * Parse and validate one command array. Every element must be a plain string:
 * a non-string, an empty one, a control character, a shell interpreter or a
 * flag carrying a placeholder fails the config load rather than being dropped.
 */
export function parsePublishArgv(
  value: unknown,
  key: string,
  where: string,
): PublishArgv {
  if (!Array.isArray(value)) {
    throw new Error(`config: publish.${key} must be an array of strings`);
  }
  if (value.length === 0) {
    throw new Error(`config: publish.${key} must not be empty`);
  }
  if (value.length > MAX_ARGV_ELEMENTS) {
    throw new Error(
      `config: publish.${key} has ${value.length} elements; the limit is ${MAX_ARGV_ELEMENTS}`,
    );
  }
  const elements: string[] = [];
  let bytes = 0;
  for (const [index, element] of value.entries()) {
    const at = `publish.${key}[${index}]`;
    if (typeof element !== "string") {
      throw new Error(`config: ${at} must be a string`);
    }
    if (element === "") {
      throw new Error(`config: ${at} must not be empty`);
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/u.test(element)) {
      throw new Error(`config: ${at} must not contain a control character`);
    }
    if (Buffer.byteLength(element, "utf8") > MAX_ELEMENT_BYTES) {
      throw new Error(
        `config: ${at} is longer than ${MAX_ELEMENT_BYTES} bytes`,
      );
    }
    if (index === 0) {
      // argv[0] is what the runtime starts: it must be a literal program, not
      // a value substituted in, and not one that evaluates text.
      if (placeholderNamesIn(element, at).length > 0) {
        throw new Error(
          `config: ${at} is the program to run, so it must be a literal; a ` +
            `placeholder may not choose the executable`,
        );
      }
      if (isRefusedProgram(element)) {
        throw new Error(
          `config: ${at} runs a shell or a text-evaluating runtime; publish ` +
            `commands are argv arrays, never a program built from a string`,
        );
      }
    }
    const names = placeholderNamesIn(element, at);
    if (isFlagShaped(element) && names.length > 0) {
      // A flag that carries a value must join it with `=`, so the value can
      // never be read as the next flag.
      const eq = element.indexOf("=");
      const firstPlaceholder = element.indexOf("{", 0);
      if (eq < 0 || firstPlaceholder < eq) {
        throw new Error(
          `config: ${at} is a flag carrying a placeholder; join the value ` +
            `to the flag with "=" (for example "--range={range}")`,
        );
      }
    }
    bytes += Buffer.byteLength(element, "utf8");
    elements.push(element);
  }
  const envChain = refusedEnvChain(elements);
  if (envChain !== null) {
    throw new Error(
      `config: ${envChain} runs "env" before a shell; publish commands are ` +
        `argv arrays, never a shell string reached through env`,
    );
  }
  if (bytes > MAX_ARGV_BYTES) {
    throw new Error(
      `config: publish.${key} carries ${bytes} bytes; the limit is ${MAX_ARGV_BYTES}`,
    );
  }
  return Object.freeze(elements);
}

/** The placeholder names one element carries, all of them declared. */
function placeholderNamesIn(
  element: string,
  at: string,
): PublishPlaceholder[] {
  const names: PublishPlaceholder[] = [];
  for (const match of element.matchAll(PLACEHOLDER_REF)) {
    const name = match[1] ?? "";
    if (!(PUBLISH_PLACEHOLDERS as readonly string[]).includes(name)) {
      throw new Error(
        `config: ${at} names an undeclared placeholder "{${name}}"; the ` +
          `declared ones are ${
            PUBLISH_PLACEHOLDERS.map((p) => `{${p}}`).join(", ")
          }`,
      );
    }
    names.push(name as PublishPlaceholder);
  }
  // A lone `{` or `}` is a typo, not a literal brace: refuse it rather than
  // pass a half-substituted element to the child.
  const braces = element.replace(PLACEHOLDER_REF, "");
  if (braces.includes("{") || braces.includes("}")) {
    throw new Error(`config: ${at} has an unbalanced brace`);
  }
  return names;
}

function readDuration(
  value: unknown,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`config: publish.${key} must be a whole number of ms`);
  }
  if (value < min || value > max) {
    throw new Error(
      `config: publish.${key} must be between ${min} and ${max} ms`,
    );
  }
  return value;
}

/**
 * The default report path: a scratch file the tool creates per ticket. The
 * template names no operator path; what the gate writes into the file is the
 * gate's own output.
 */
export function defaultPublishReportPath(): string {
  return join(tmpdir(), "dyfj-publish", "{ticket}.log");
}

function readReportPath(value: unknown, where: string): string {
  if (value === undefined) return defaultPublishReportPath();
  if (typeof value !== "string" || value === "") {
    throw new Error(`config: publish.report_path must be a non-empty string`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(
      `config: publish.report_path must not contain a control character`,
    );
  }
  const names = placeholderNamesIn(value, "publish.report_path");
  // `{report}` is the path itself: naming it inside its own template is a loop.
  if (names.includes("report")) {
    throw new Error(
      `config: publish.report_path must not name {report}; that placeholder ` +
        `is the report path`,
    );
  }
  // One ticket, one file: an unsubstituted template would have every run
  // append to the same file, and a later start could read an earlier run.
  const lastSegment = value.split("/").pop() ?? "";
  if (!lastSegment.includes("{ticket}")) {
    throw new Error(
      `config: publish.report_path must put {ticket} in its final path ` +
        `component, so one ticket's report never overwrites another's ` +
        `(${configLabel(where)})`,
    );
  }
  // A path is not re-resolved after substitution: `..` would climb out of the
  // directory the operator meant.
  if (value.split(/[\\/]/u).includes("..")) {
    throw new Error(
      `config: publish.report_path must not contain a ".." segment`,
    );
  }
  if (Buffer.byteLength(value, "utf8") > MAX_ELEMENT_BYTES) {
    throw new Error(`config: publish.report_path is too long`);
  }
  return value;
}

/**
 * Parse the `[publish]` table. Returns null when the table is absent: the
 * publish tool is then not registered at all, which is the only way to have
 * no publish commands.
 */
export function parsePublishConfig(
  table: Record<string, unknown> | null,
  where: string,
): PublishConfig | null {
  if (table === null) return null;
  const section = table["publish"];
  if (section === undefined) return null;
  if (typeof section !== "object" || section === null || Array.isArray(section)) {
    throw new Error(`config: [publish] must be a table in ${configLabel(where)}`);
  }
  const values = section as Record<string, unknown>;
  for (const key of Object.keys(values)) {
    if (!PUBLISH_KEYS.has(key)) {
      throw new Error(
        `config: unknown key publish.${key} in ${configLabel(where)}`,
      );
    }
  }
  if (values["pre_gate"] === undefined || values["gate"] === undefined) {
    throw new Error(
      `config: publish.pre_gate and publish.gate are both required in ` +
        `${configLabel(where)}`,
    );
  }
  return Object.freeze({
    preGate: parsePublishArgv(values["pre_gate"], "pre_gate", where),
    gate: parsePublishArgv(values["gate"], "gate", where),
    reportPath: readReportPath(values["report_path"], where),
    gateTimeoutMs: readDuration(
      values["gate_timeout_ms"],
      "gate_timeout_ms",
      DEFAULT_GATE_TIMEOUT_MS,
      MIN_GATE_TIMEOUT_MS,
      MAX_GATE_TIMEOUT_MS,
    ),
    ticketTtlMs: readDuration(
      values["ticket_ttl_ms"],
      "ticket_ttl_ms",
      DEFAULT_TICKET_TTL_MS,
      MIN_TICKET_TTL_MS,
      MAX_TICKET_TTL_MS,
    ),
  });
}

/**
 * Fill one template's placeholders from host-resolved values, returning the
 * argv to spawn. Substitution happens WITHIN an element, never by splitting,
 * so a value carrying whitespace stays one argument. A substituted element
 * that would begin with a dash is refused when the template did not already
 * join it to a flag with `=`: a value must never become a flag.
 */
export function fillPublishArgv(
  template: PublishArgv,
  values: PublishValues,
): string[] {
  let bytes = 0;
  const filled = template.map((element, index) => {
    const text = element.replace(PLACEHOLDER_REF, (_all, raw: string) => {
      // `parsePublishConfig` refuses an undeclared placeholder; this repeats
      // the check for a template that did not come from the loader.
      if (!(PUBLISH_PLACEHOLDERS as readonly string[]).includes(raw)) {
        throw new Error(`config: publish placeholder {${raw}} is not declared`);
      }
      const name = raw as PublishPlaceholder;
      const value = values[name];
      if (typeof value !== "string") {
        throw new Error(`config: publish placeholder {${name}} has no value`);
      }
      // Each value is bounded before it is substituted, so a long value
      // repeated across a template cannot grow the element far before the
      // element bound below refuses it.
      if (Buffer.byteLength(value, "utf8") > MAX_ELEMENT_BYTES) {
        throw new Error(
          `config: publish placeholder {${name}} is longer than ` +
            `${MAX_ELEMENT_BYTES} bytes`,
        );
      }
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u001f\u007f]/u.test(value)) {
        throw new Error(
          `config: publish placeholder {${name}} contains a control character`,
        );
      }
      return value;
    });
    if (index > 0 && isFlagShaped(text) && !isFlagShaped(element)) {
      // The value chose the flag: refuse rather than hand it to the child.
      throw new Error(
        `config: publish argument ${index} would begin with "-" after ` +
          `substitution; refusing to pass a value as a flag`,
      );
    }
    if (Buffer.byteLength(text, "utf8") > MAX_ELEMENT_BYTES) {
      // The bound is on what is started, not only on what was written in the
      // config file: a value can be longer than any literal.
      throw new Error(
        `config: publish argument ${index} is longer than ${MAX_ELEMENT_BYTES} ` +
          `bytes after substitution`,
      );
    }
    if (index === 0 && isRefusedProgram(text)) {
      // `fillPublishArgv` is callable on a template that did not come from
      // the loader, so the program check is made on the argv it returns.
      throw new Error(
        `config: publish argument 0 runs a shell or a text-evaluating ` +
          `runtime; publish commands are argv arrays`,
      );
    }
    bytes += Buffer.byteLength(text, "utf8");
    if (bytes > MAX_ARGV_BYTES) {
      // The whole argv's bound is on what is started too: placeholders can
      // lengthen it past what the config file held.
      throw new Error(
        `config: publish argument ${index} puts the command over ${MAX_ARGV_BYTES} ` +
          `bytes after substitution`,
      );
    }
    return text;
  });
  const envChain = refusedEnvChain(filled);
  if (envChain !== null) {
    throw new Error(
      `config: ${envChain} runs env ahead of a shell after substitution`,
    );
  }
  return filled;
}

/** The report path for one ticket, placeholders filled. */
export function publishReportPathFor(
  config: PublishConfig,
  values: PublishValues,
): string {
  const path = fillPublishArgv([config.reportPath], values)[0]!;
  // The template was refused at load if it carried `..`; a value must not
  // introduce one either.
  if (path.split("/").includes("..")) {
    throw new Error(
      `config: publish.report_path would contain ".." after substitution`,
    );
  }
  return path;
}

/** Load `[publish]` from the config file the environment names. */
export async function loadPublishConfig(
  deps: LoadConfigDeps = {},
): Promise<PublishConfig | null> {
  const env = deps.env ?? processEnv;
  const path = configFilePath(env);
  const table = await readConfigFile(
    path,
    deps.readTextFile ?? defaultReadTextFile,
    deps.parseToml ?? defaultParseToml,
  );
  return parsePublishConfig(table, path);
}
