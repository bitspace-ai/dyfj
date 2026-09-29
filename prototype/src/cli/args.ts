/**
 * Command-line parsing, config resolution and help text for the `dyfj`
 * client. `parseArgs` is also the launcher's validity contract, through
 * `main --parse-check`.
 */

import { SESSION_ID_SHAPE } from "../contract/mod.ts";
import { resolveSocketPath } from "../transport/mod.ts";

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
   * Fast speed tier for supported models (e.g. gpt-5.6 series in Codex).
   * Requests the fast service tier for prioritized generation throughput.
   */
  fast?: boolean;
  color: boolean;
}

/**
 * Accept a session reference as either the bare 26-char session id or the
 * slug exactly as `dyfj sessions` lists it (workbench-<id>, lowercased).
 * Returns the canonical uppercase session id.
 */
export function normalizeSessionRef(value: string): string {
  const slugMatch = value.match(/^workbench-([0-9A-Za-z]{26})$/i);
  const candidate = slugMatch ? slugMatch[1] : value;
  if (!SESSION_ID_SHAPE.test(candidate)) {
    throw new Error(
      `--session expects a session id or a slug as listed by 'dyfj sessions', got: ${value}`,
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
  "--runner",
  "-p",
  "--print",
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const overrides: Partial<CliConfig> = {};
  const positional: string[] = [];
  let json = false;
  let printPrompt: string | undefined;
  let help = false;
  let launcherAutostarted = false;
  let seenFast: boolean | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
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
      if (arg === "--socket") overrides.socket = value;
      else if (arg === "--model") overrides.model = value;
      else if (arg === "--runner") {
        if (value !== "fixture" && value !== "codex-chatgpt") {
          return error("--runner must be fixture or codex-chatgpt");
        }
        overrides.runner = value;
      } else if (arg === "--session") {
        // normalizeSessionRef throws on garbage; route it through the standard
        // usage-error path (exit 2) instead of an uncaught stack trace.
        try {
          overrides.sessionId = normalizeSessionRef(value);
        } catch (thrown) {
          return error(
            thrown instanceof Error ? thrown.message : String(thrown),
          );
        }
      } else if (arg === "--workspace") overrides.workspace = value;
      else if (arg === "-p" || arg === "--print") printPrompt = value;
      else if (arg === "--mode") {
        if (value !== "turn" && value !== "ask" && value !== "next-work") {
          return error("--mode must be turn, ask, or next-work");
        }
        overrides.mode = value;
      } else if (arg === "--tier") {
        const tier = Number(value);
        if (tier !== 0 && tier !== 1 && tier !== 2) {
          return error("--tier must be 0, 1, or 2");
        }
        overrides.tier = tier;
      } else if (arg === "--hint") {
        if (value !== "code" && value !== "chat" && value !== "reasoning") {
          return error("--hint must be code, chat, or reasoning");
        }
        overrides.hint = value;
      }
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
    overrides.runner !== undefined &&
    (overrides.model !== undefined || overrides.tier !== undefined ||
      overrides.hint !== undefined || overrides.fast !== undefined)
  ) {
    return error(
      "--runner cannot be combined with --model, --tier, --hint, or --fast/--no-fast",
    );
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
  if (positional[0] === "sessions" && positional.length === 1) {
    return { command: "sessions", json, overrides };
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
    socket: overrides.socket ?? resolveSocketPath(env),
    // Turns always use the UDS seam. unix remains set so REPL idea/packet
    // extras use JSON-RPC; tests may pass unix: false for the in-process registry.
    unix: overrides.unix ?? true,
    approvePaid: overrides.approvePaid ?? false,
    fast: overrides.fast,
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

Launcher lifecycle (the dyfj wrapper script, local UDS seam only):
  a REPL or one-shot turn probes the socket first and, when no runtime
  answers, starts one detached (output to ~/.dyfj/log/) and waits for it.
  'start', 'status', 'stop', and help (when invoked without a prompt) never
  trigger autostart. Opt out per call with --no-autostart, or standing with
  DYFJ_AUTOSTART=0.

REPL commands:
  /model [<slug>]           show or switch the active model (validated slugs);
                            add --approve-paid to opt this session into paid
                            (hosted) inference when escalating; add --fast or
                            --no-fast to toggle fast speed tier
  /fast [on|off]            toggle or set fast speed tier (for supported models)
  /session                  show the current session id (for --session resume)
  /friction <sev> [--escaped] <text...>
                            post a daily-driver friction entry
  /exit, /quit              exit the REPL

Options:
  --mode <m>       context mode: turn (companion+memory, default) | ask | next-work (repo)
  --socket <path>  local UDS socket path (env DYFJ_SOCKET)
  --model <slug>   model id      --tier <0|1|2>   --hint <code|chat|reasoning>
  --fast           enable fast speed tier for supported models (faster generation)
  --no-fast        disable fast speed tier (standard speed)
  --runner <name>  local ACP runner: fixture | codex-chatgpt (experimental;
                   codex-chatgpt requires trusted workspace config)
  --session <ref>  resume a session (accepts the id or the slug from 'dyfj sessions')
  --workspace <d>  dir to scope file tools to (default: cwd, env DYFJ_WORKSPACE)
  --approve-paid   opt into paid (hosted) inference (loopback only; persists in REPL)
  --no-autostart   launcher only: do not auto-start a runtime for this call (env DYFJ_AUTOSTART=0)
  --parse-check    launcher-internal, first argument only: validate the rest and exit 0/2
  --json           one-shot only: print the full result as JSON
  -h, --help       show this help`;
