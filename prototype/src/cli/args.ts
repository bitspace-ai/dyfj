/**
 * Command-line parsing, config resolution and help text for the `dyfj`
 * client. `parseArgs` is also the launcher's validity contract, through
 * `main --parse-check`.
 */

import {
  type CodexReasoningEffort,
  codexReasoningEffortRefusal,
  isCodexReasoningEffort,
} from "../config/mod.ts";
import { isAbsolute } from "node:path";
import {
  type AdditionalRootRequest,
  MAX_ADDITIONAL_ROOTS,
  SESSION_ID_SHAPE,
} from "../contract/mod.ts";
import { resolveSocketPath } from "../transport/mod.ts";
import {
  BUDGET_FLAGS,
  MAX_BUDGET_USD,
  parseBudgetUsd,
  type SessionBudget,
} from "./budget.ts";

export interface CliConfig {
  /**
   * Context mode: native "turn" = companion + memory; native
   * "ask"/"next-work" = repo context. External runners receive the literal
   * prompt and selected workspace.
   */
  mode: "turn" | "ask" | "next-work";
  model?: string;
  tier?: 0 | 1 | 2;
  hint?: "code" | "chat" | "reasoning";
  runner?: "fixture" | "codex-chatgpt";
  sessionId?: string;
  /** Working directory sent to the server to scope read-only file tools. */
  workspace?: string;
  /** True when workspace came from --workspace/DYFJ_WORKSPACE, not the cwd default. */
  workspaceExplicit?: boolean;
  /**
   * Extra roots beside the workspace (--add-dir, else DYFJ_ADD_DIRS), sent
   * on every turn. Absolute after resolveConfig; as typed in overrides.
   */
  additionalRoots?: AdditionalRootRequest[];
  /** Unix socket path for the JSON-RPC seam. */
  socket: string;
  /**
   * Use UDS JSON-RPC for REPL idea/packet/session extras. Turns always use
   * the seam; when false, those extras use the in-process registry.
   */
  unix?: boolean;
  /**
   * Opt into paid (hosted) inference for this turn/session (--approve-paid).
   * Persists across a REPL session; the engine gates it loopback-only.
   */
  approvePaid?: boolean;
  /**
   * Fast speed tier for supported models (e.g. the gpt-6 series in Codex).
   * Requests the fast service tier for prioritized generation throughput.
   */
  fast?: boolean;
  /**
   * The session's reasoning effort on the Codex ChatGPT route (--effort,
   * /effort), sent on every turn. Undefined leaves the runtime's configured
   * default, `medium` unless [codex] reasoning_effort sets one.
   */
  effort?: CodexReasoningEffort;
  /**
   * The session's own tool-step limit (--tool-steps, /steps), sent on every
   * native turn; an external runner keeps its own loop and is sent none.
   * Undefined leaves the runtime's configured limit.
   */
  toolSteps?: number;
  /**
   * The session's own spend limits (--budget-*, /budget), sent on every
   * native turn; an absent limit is the runtime's configured one.
   */
  budget?: SessionBudget;
  color: boolean;
}

/**
 * Accept a session reference as either the bare 26-char session id or the
 * slug exactly as `dyfj sessions` lists it (workbench-<id>, lowercased).
 * Returns the canonical uppercase session id.
 */
export function normalizeSessionRef(
  value: string,
  caller = "--session",
): string {
  const slugMatch = value.match(/^workbench-([0-9A-Za-z]{26})$/i);
  const candidate = slugMatch ? slugMatch[1] : value;
  if (!SESSION_ID_SHAPE.test(candidate)) {
    throw new Error(
      `${caller} expects a session id or a slug as listed by 'dyfj sessions', got: ${value}`,
    );
  }
  return candidate.toUpperCase();
}

export interface ParsedArgs {
  command:
    | "exec"
    | "repl"
    | "help"
    | "models"
    | "sessions"
    | "status"
    | "start"
    | "stop";
  prompt?: string;
  /** Canonical session id for `dyfj sessions show <ref> --events`. */
  sessionEventsId?: string;
  /** Canonical session id for `dyfj sessions show <ref>`, without `--events`. */
  sessionShowId?: string;
  json: boolean;
  overrides: Partial<CliConfig>;
  launcherAutostarted?: true;
  error?: string;
}

const VALUE_FLAGS = new Set([
  "--socket",
  "--mode",
  "--model",
  "--tier",
  "--hint",
  "--session",
  "--workspace",
  "--add-dir",
  "--runner",
  "--tool-steps",
  "--effort",
  ...Object.keys(BUDGET_FLAGS),
  "-p",
  "--print",
]);

/**
 * The bound on a session's tool-step limit. The runtime's configured ceiling
 * can be lower; the runtime refuses a turn above it.
 */
export const TOOL_STEPS_BOUND = 64;

/** A tool-step limit as typed: an integer from 1 through the bound. */
export function parseToolSteps(value: string): number | undefined {
  if (!/^[0-9]+$/.test(value)) return undefined;
  const steps = Number(value);
  return steps >= 1 && steps <= TOOL_STEPS_BOUND ? steps : undefined;
}

function parseSessionsCommand(
  positional: readonly string[],
  events: boolean,
  json: boolean,
  overrides: Partial<CliConfig>,
): ParsedArgs {
  if (positional.length === 1) {
    return { command: "sessions", json, overrides };
  }
  if (positional[1] !== "show") {
    return {
      command: "help",
      json,
      overrides,
      error:
        `unknown sessions subcommand: ${positional[1]} (expected 'show <session> [--events]')`,
    };
  }
  if (positional.length < 3) {
    return {
      command: "help",
      json,
      overrides,
      error: "sessions show requires a session id or slug",
    };
  }
  if (positional.length > 3) {
    return {
      command: "help",
      json,
      overrides,
      error: "sessions show takes a single session id or slug",
    };
  }
  try {
    const sessionId = normalizeSessionRef(positional[2], "sessions show");
    return {
      command: "sessions",
      ...(events
        ? { sessionEventsId: sessionId }
        : { sessionShowId: sessionId }),
      json,
      overrides,
    };
  } catch (thrown) {
    return {
      command: "help",
      json,
      overrides,
      error: thrown instanceof Error ? thrown.message : String(thrown),
    };
  }
}

function applyValueFlag(
  arg: string,
  value: string,
  overrides: Partial<CliConfig>,
  setPrompt: (prompt: string) => void,
): string | undefined {
  if (arg === "--socket") overrides.socket = value;
  else if (arg === "--model") overrides.model = value;
  else if (arg === "--runner") {
    if (value !== "fixture" && value !== "codex-chatgpt") {
      return "--runner must be fixture or codex-chatgpt";
    }
    overrides.runner = value;
  } else if (arg === "--session") {
    // normalizeSessionRef throws on garbage; route it through the standard
    // usage-error path (exit 2) instead of an uncaught stack trace.
    try {
      overrides.sessionId = normalizeSessionRef(value);
    } catch (thrown) {
      return thrown instanceof Error ? thrown.message : String(thrown);
    }
  } else if (arg === "--workspace") overrides.workspace = value;
  else if (arg === "--add-dir") {
    const root = parseAddDir(value);
    if (root === undefined) return "--add-dir expects <path> or <path>:ro";
    const roots = [...(overrides.additionalRoots ?? []), root];
    if (roots.length > MAX_ADDITIONAL_ROOTS) {
      return `--add-dir may be given at most ${MAX_ADDITIONAL_ROOTS} times`;
    }
    overrides.additionalRoots = roots;
  } else if (arg === "--effort") {
    if (!isCodexReasoningEffort(value)) {
      return codexReasoningEffortRefusal("--effort");
    }
    overrides.effort = value;
  } else if (arg === "--tool-steps") {
    const steps = parseToolSteps(value);
    if (steps === undefined) {
      return `--tool-steps must be an integer from 1 through ${TOOL_STEPS_BOUND}`;
    }
    overrides.toolSteps = steps;
  } else if (Object.hasOwn(BUDGET_FLAGS, arg)) {
    const usd = parseBudgetUsd(value);
    if (usd === undefined) {
      return `${arg} must be a dollar amount above 0 and at most ${MAX_BUDGET_USD}`;
    }
    overrides.budget = { ...overrides.budget, [BUDGET_FLAGS[arg]]: usd };
  } else if (arg === "-p" || arg === "--print") setPrompt(value);
  else if (arg === "--mode") {
    if (value !== "turn" && value !== "ask" && value !== "next-work") {
      return "--mode must be turn, ask, or next-work";
    }
    overrides.mode = value;
  } else if (arg === "--tier") {
    const tier = Number(value);
    if (tier !== 0 && tier !== 1 && tier !== 2) {
      return "--tier must be 0, 1, or 2";
    }
    overrides.tier = tier;
  } else if (arg === "--hint") {
    if (value !== "code" && value !== "chat" && value !== "reasoning") {
      return "--hint must be code, chat, or reasoning";
    }
    overrides.hint = value;
  }
  return undefined;
}

/**
 * One `--add-dir` value: `<path>` is read-write, `<path>:ro` read-only.
 * Undefined when the path is empty.
 */
export function parseAddDir(value: string): AdditionalRootRequest | undefined {
  const trimmed = value.trim();
  const readOnly = trimmed.endsWith(":ro");
  const path = (readOnly ? trimmed.slice(0, -":ro".length) : trimmed).trim();
  return path === "" ? undefined : { path, readOnly };
}

/**
 * The session's extra roots: the --add-dir flags when any were given, else
 * the comma-separated DYFJ_ADD_DIRS. Each path is made absolute against the
 * client's cwd; a leading `~/` is the home directory. Empty entries in the
 * variable are skipped, and entries past the limit are dropped (the runtime
 * refuses more than the limit).
 */
export function resolveAdditionalRoots(
  flagged: readonly AdditionalRootRequest[] | undefined,
  env: { get(key: string): string | undefined },
  cwd: string,
): AdditionalRootRequest[] {
  const typed = flagged ?? fromEnv(env.get("DYFJ_ADD_DIRS") ?? "");
  const home = env.get("HOME");
  return typed.map(({ path, readOnly }) => {
    const expanded = home !== undefined && (path === "~" || path.startsWith("~/"))
      ? home + path.slice(1)
      : path;
    // Joined, not resolved: folding `..` here could pick another directory
    // than the filesystem does through a symlink. The runtime canonicalizes.
    return {
      path: isAbsolute(expanded) ? expanded : `${cwd.replace(/\/+$/, "")}/${expanded}`,
      readOnly,
    };
  });
}

/** The first `MAX_ADDITIONAL_ROOTS` non-empty entries of `DYFJ_ADD_DIRS`. */
function fromEnv(value: string): AdditionalRootRequest[] {
  const roots: AdditionalRootRequest[] = [];
  let start = 0;
  while (start <= value.length && roots.length < MAX_ADDITIONAL_ROOTS) {
    const comma = value.indexOf(",", start);
    const end = comma === -1 ? value.length : comma;
    const root = parseAddDir(value.slice(start, end));
    if (root !== undefined) roots.push(root);
    start = end + 1;
  }
  return roots;
}

/** The slug prefix of the Codex ChatGPT route's models. */
export const CODEX_MODEL_PREFIX = "codex-chatgpt/";

export function parseArgs(argv: string[]): ParsedArgs {
  const overrides: Partial<CliConfig> = {};
  const positional: string[] = [];
  let json = false;
  let events = false;
  let printPrompt: string | undefined;
  let help = false;
  let launcherAutostarted = false;
  let seenFast: boolean | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--events") {
      events = true;
    } else if (arg === "--launcher-autostarted") {
      launcherAutostarted = true;
    } else if (arg === "--approve-paid") {
      overrides.approvePaid = true;
    } else if (arg === "--fast") {
      if (seenFast === false) {
        return error("cannot specify both --fast and --no-fast");
      }
      seenFast = true;
      overrides.fast = true;
    } else if (arg === "--no-fast") {
      if (seenFast === true) {
        return error("cannot specify both --fast and --no-fast");
      }
      seenFast = false;
      overrides.fast = false;
    } else if (arg === "-h" || arg === "--help") {
      help = true;
    } else if (VALUE_FLAGS.has(arg)) {
      const value = argv[++i];
      if (value === undefined) return error(`missing value for ${arg}`);
      const problem = applyValueFlag(
        arg,
        value,
        overrides,
        (prompt) => {
          printPrompt = prompt;
        },
      );
      if (problem !== undefined) return error(problem);
    } else if (arg.startsWith("-") && arg !== "-") {
      return error(`unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (
    launcherAutostarted &&
    !(
      !help && printPrompt === undefined && positional[0] === "start" &&
      positional.length === 1
    )
  ) {
    return error("--launcher-autostarted is valid only with start");
  }

  if (help) return { command: "help", json, overrides };
  if (
    events &&
    !(
      printPrompt === undefined && positional[0] === "sessions" &&
      positional[1] === "show"
    )
  ) {
    return error("--events is valid only with 'sessions show <session>'");
  }
  if (
    overrides.runner !== undefined &&
    (overrides.model !== undefined || overrides.tier !== undefined ||
      overrides.hint !== undefined || overrides.fast !== undefined)
  ) {
    return error(
      "--runner cannot be combined with --model, --tier, --hint, or --fast/--no-fast",
    );
  }
  // The runtime refuses an effort on any other route too; this catches the
  // routes the command line already names.
  if (
    overrides.effort !== undefined &&
    (overrides.runner === "fixture" ||
      (overrides.model !== undefined &&
        !overrides.model.startsWith(CODEX_MODEL_PREFIX)))
  ) {
    return error("--effort applies only to codex-chatgpt/* models");
  }
  if (
    overrides.runner !== undefined &&
    ["models", "sessions", "status", "start", "stop"].includes(positional[0])
  ) {
    return error(`--runner cannot be combined with '${positional[0]}'`);
  }
  if (printPrompt !== undefined) {
    return { command: "exec", prompt: printPrompt, json, overrides };
  }

  if (positional[0] === "models" && positional.length === 1) {
    return { command: "models", json, overrides };
  }
  if (positional[0] === "sessions") {
    return parseSessionsCommand(positional, events, json, overrides);
  }
  if (positional[0] === "status" && positional.length === 1) {
    return { command: "status", json, overrides };
  }
  if (positional[0] === "start" && positional.length === 1) {
    return {
      command: "start",
      json,
      overrides,
      ...(launcherAutostarted ? { launcherAutostarted: true as const } : {}),
    };
  }
  if (positional[0] === "stop" && positional.length === 1) {
    return { command: "stop", json, overrides };
  }
  if (positional[0] === "exec") {
    const prompt = positional.slice(1).join(" ").trim();
    if (prompt.length === 0) {
      return {
        command: "exec",
        json,
        overrides,
        error: "exec requires a prompt",
      };
    }
    return { command: "exec", prompt, json, overrides };
  }
  // `dyfj ask "<prompt>"` — sugar for a one-shot repo-context (ask-mode) turn.
  if (positional[0] === "ask") {
    const prompt = positional.slice(1).join(" ").trim();
    if (prompt.length === 0) {
      return {
        command: "exec",
        json,
        overrides,
        error: "ask requires a prompt",
      };
    }
    return {
      command: "exec",
      prompt,
      json,
      overrides: { ...overrides, mode: "ask" },
    };
  }
  if (positional.length > 0) {
    return error(`unknown command: ${positional[0]}`);
  }
  return { command: "repl", json, overrides };

  function error(message: string): ParsedArgs {
    return { command: "help", json, overrides, error: message };
  }
}

export function resolveConfig(
  overrides: Partial<CliConfig>,
  env: { get(key: string): string | undefined },
  isTty = false,
  cwd = ".",
): CliConfig {
  const tierEnv = env.get("DYFJ_WORKBENCH_TIER");
  const tier = tierEnv === "0" || tierEnv === "1" || tierEnv === "2"
    ? (Number(tierEnv) as 0 | 1 | 2)
    : undefined;
  const hintEnv = env.get("DYFJ_WORKBENCH_HINT");
  const hint =
    hintEnv === "code" || hintEnv === "chat" || hintEnv === "reasoning"
      ? hintEnv
      : undefined;
  const explicitWorkspace = overrides.workspace ?? env.get("DYFJ_WORKSPACE");
  const additionalRoots = resolveAdditionalRoots(
    overrides.additionalRoots,
    env,
    cwd,
  );
  return {
    mode: overrides.mode ?? "turn",
    model: overrides.model ?? env.get("DYFJ_WORKBENCH_MODEL"),
    tier: overrides.tier ?? tier,
    hint: overrides.hint ?? hint,
    runner: overrides.runner,
    sessionId: overrides.sessionId,
    // Workspace follows the directory `dyfj` runs in; --workspace or
    // DYFJ_WORKSPACE override it. The UDS seam is local, so the implicit cwd
    // is always sent on a new session (buildTurnBody).
    workspace: explicitWorkspace ?? cwd,
    workspaceExplicit: explicitWorkspace !== undefined,
    ...(additionalRoots.length === 0 ? {} : { additionalRoots }),
    socket: overrides.socket ?? resolveSocketPath(env),
    // Turns always use the UDS seam. unix remains set so REPL idea/packet
    // extras use JSON-RPC; tests may pass unix: false for the in-process registry.
    unix: overrides.unix ?? true,
    approvePaid: overrides.approvePaid ?? false,
    fast: overrides.fast,
    ...(overrides.effort === undefined ? {} : { effort: overrides.effort }),
    ...(overrides.toolSteps === undefined
      ? {}
      : { toolSteps: overrides.toolSteps }),
    ...(overrides.budget === undefined ? {} : { budget: overrides.budget }),
    color: !env.get("NO_COLOR") && isTty,
  };
}

export const HELP = `dyfj — Workbench daily-driver client

Talks to the local runtime over the UDS seam; a bare invocation
starts the runtime itself if none is answering (see Launcher lifecycle
below), and \`dyfj start\` still runs one in the foreground by hand. Permission posture (strict | operator) is engine config in
~/.dyfj/config.toml, not a flag here.

Usage:
  dyfj                      interactive REPL (multi-turn, streaming)
  dyfj exec "<prompt>"      one-shot turn
  dyfj ask "<prompt>"       one-shot repo-context question (ask mode)
  dyfj -p "<prompt>"        one-shot turn (alias)
  dyfj status               check the local runtime and socket
  dyfj start                foreground the local runtime (Ctrl-C to stop)
  dyfj stop                 stop the running local runtime at the socket
  dyfj models               list available model slugs
  dyfj sessions             list sessions
  dyfj sessions show <ref> [--json]
                            print a session's workspace, model and lineage
  dyfj sessions show <ref> --events [--json]
                            print a session's recorded turns and tool events
  dyfj dev                  launcher only: work on the harness; reload the
                            runtime and the Rust REPL when their code changes

Launcher lifecycle (the dyfj wrapper script, local UDS seam only):
  a REPL or one-shot turn probes the socket first and, when no runtime
  answers, starts one detached (output to ~/.dyfj/log/) and waits for it.
  'start', 'status', 'stop', and help (when invoked without a prompt) never
  trigger autostart. Opt out per call with --no-autostart, or standing with
  DYFJ_AUTOSTART=0. The client and the runtime run on Node 26 (the node on
  PATH); the launcher refuses to start on any other version.

REPL commands:
  /model [<slug>]           show or switch the active model (validated slugs);
                            add --approve-paid to opt this session into paid
                            (hosted) inference when escalating; add --fast or
                            --no-fast to toggle fast speed tier
  /fast [on|off]            toggle or set fast speed tier (for supported models)
  /effort [<level>|default] show or set the reasoning effort of a codex-chatgpt
                            model (low, medium, high, xhigh) from the next turn
  /steps [N]                show or set this session's tool-step limit; a value
                            above the runtime's ceiling is refused
  /budget [<limit> <usd>]   show the spend limits, or set one for this session:
                            turn, session, day, per-call or runaway
  /session                  show the current session id (for --session resume)
                            and the session's added roots
  /friction <sev> [--escaped] <text...>
                            post a daily-driver friction entry
  /help                     list the REPL commands
  /exit, /quit              exit the REPL
  //word                    send "/word" as text; any other unknown /word is
                            refused locally, at no cost

Options:
  --mode <m>       context mode: turn (companion+memory, default) | ask | next-work (repo)
  --socket <path>  local UDS socket path (env DYFJ_SOCKET)
  --model <slug>   model id      --tier <0|1|2>   --hint <code|chat|reasoning>
  --fast           enable fast speed tier for supported models (faster generation)
  --no-fast        disable fast speed tier (standard speed)
  --effort <level> reasoning effort for codex-chatgpt/* models: low, medium,
                   high or xhigh (default: [codex] reasoning_effort, else medium)
  --tool-steps <N> this session's tool-step limit, 1 through 64 and not above
                   the runtime's ceiling (DYFJ_MAX_TOOL_STEPS_CEILING)
  --budget-turn <usd>, --budget-session <usd>, --budget-day <usd>,
  --budget-per-call <usd>, --budget-runaway <usd>
                   this session's spend limits (default: the runtime's
                   [budget] config); runaway is spend with no tool progress
  --runner <name>  local ACP runner: fixture | codex-chatgpt (experimental;
                   codex-chatgpt requires trusted workspace config)
  --session <ref>  resume a session (accepts the id or the slug from 'dyfj sessions')
  --workspace <d>  dir to scope file tools to (default: cwd, env DYFJ_WORKSPACE)
  --add-dir <d>[:ro]
                   another root this session may use, read-write, or read-only
                   with :ro; repeatable, up to 16 (env DYFJ_ADD_DIRS, comma-
                   separated). Sent on every turn, not stored with the session.
                   The runtime refuses a root that is, contains or sits inside
                   ~/.dyfj, ~/.config/dyfj, DYFJ_ROOT or the runtime's
                   prototype/.env. Native file tools reach a root through their
                   root argument; on codex-chatgpt only read-write roots are
                   sent, as writable roots
  --approve-paid   opt into paid (hosted) inference (loopback only; persists in REPL)
  --no-autostart   launcher only: do not auto-start a runtime for this call (env DYFJ_AUTOSTART=0)
  --parse-check    launcher-internal, first argument only: validate the rest and exit 0/2
  --events         with 'sessions show <ref>': print recorded turns and tool events
  --json           one-shot or 'sessions show': print the result as JSON
  -h, --help       show this help`;
