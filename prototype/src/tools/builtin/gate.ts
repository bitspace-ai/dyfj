import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { Env, GateConfig, GateMode, RuntimePolicy } from "../../config/mod.ts";
import { CommandExecutionError, type CommandCall, type CommandDefinition } from "../definition.ts";
import { buildSafeBashEnv, executorSocket } from "./exec.ts";
import { type CommandSandbox, offSandbox, sandboxContainment } from "./srt-sandbox.ts";
import { SANDBOX_NPM_CACHE } from "./srt-policy.ts";
import { GateRuns, type GateView } from "./gate-runs.ts";

export const GATE_START_APPROVALS = { id: "gate/start", sessionGrantModes: ["full"] } as const;

export interface GateRuntimePorts {
  sessionGrantable?: readonly string[];
  config: GateConfig;
  runs: GateRuns;
  policy?: RuntimePolicy;
  maxWaitSeconds?: number;
}
export interface GateToolDeps extends GateRuntimePorts {
  sessionId: string;
  workspaceRoot: string;
  env?: Env;
  sandbox?: CommandSandbox;
}

async function checkedPaths(root: string, call: CommandCall): Promise<string[]> {
  const paths = call.arguments.paths;
  if (call.arguments.mode !== "files") {
    if (paths !== undefined) throw new Error("gate: paths applies only to files mode");
    return [];
  }
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 100) {
    throw new Error("gate: files mode requires 1 to 100 paths");
  }
  const canonicalRoot = await realpath(root);
  const output: string[] = [];
  for (const path of paths) {
    if (typeof path !== "string" || path === "" || path.length > 4096 ||
        isAbsolute(path) || path.includes("\0") || path.split(/[/\\]/).includes("..")) {
      throw new Error("gate: paths must be workspace-relative files without traversal");
    }
    let canonical: string;
    try { canonical = await realpath(resolve(canonicalRoot, path)); }
    catch { throw new Error("gate: a requested file does not exist"); }
    const rel = relative(canonicalRoot, canonical);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith("../")) {
      throw new Error("gate: a requested file leaves the workspace");
    }
    if (!(await stat(canonical)).isFile()) throw new Error("gate: paths must name files");
    output.push(`./${rel}`);
  }
  return output;
}

export function defineGateTools(deps: GateToolDeps): CommandDefinition<GateView>[] {
  const { config, runs, sessionId, workspaceRoot } = deps;
  if (config.commands.full === undefined) return [];
  const sandbox = executorSocket(deps.env) === undefined && deps.sandbox?.status.state === "on"
    ? deps.sandbox : undefined;
  const modes = (Object.keys(config.commands) as GateMode[]).filter(mode => mode === "full" || sandbox !== undefined);
  const containment = {
    ...sandboxContainment(sandbox ?? offSandbox("gate files and fast modes are unavailable")),
    escapesSandbox: (call: CommandCall) => call.arguments.mode === "full",
  };
  const validate = async (call: CommandCall): Promise<string | null> => {
    if (!modes.includes(call.arguments.mode as GateMode)) return "gate: mode is unavailable";
    const active = runs.active(sessionId);
    if (active !== undefined) return `gate: run ${active} is still active`;
    try { await checkedPaths(workspaceRoot, call); return null; }
    catch (error) { return (error as Error).message; }
  };
  const start: CommandDefinition<GateView> = {
    ...GATE_START_APPROVALS, sessionGrantable: deps.sessionGrantable, title: "Run gate (full runs worktree code on the host, outside any sandbox)",
    description: "Start the configured gate and return a run id immediately. Full runs worktree code on the host, outside any sandbox, and requires a reason and approval unless the operator opted in and granted full mode for this session. Files runs selected test files under srt; fast runs the configured fast command under srt without paths. Only one run per session may be active.",
    inputSchema: { type: "object", required: ["mode"], properties: {
      mode: { type: "string", enum: modes },
      paths: { type: "array", items: { type: "string" }, maxItems: 100, description: "Non-empty workspace-relative files, for files mode only; refused for full and fast." },
      reason: { type: "string", description: "Required for full: why host execution is needed." },
    }, additionalProperties: false },
    permission: { effects: ["run.process", "read.filesystem", "write.filesystem", "emit.event"], defaultDecision: "allow", resources: ["process:run"], filesystem: "write", network: "external", cost: "none" },
    containment, precheck: validate,
    executor: async call => {
      const failure = await validate(call);
      if (failure !== null) throw new CommandExecutionError(failure);
      const paths = await checkedPaths(workspaceRoot, call);
      const mode = call.arguments.mode as GateMode;
      const env = buildSafeBashEnv(deps.env);
      return runs.start(sessionId, {
        root: workspaceRoot, mode, paths: (call.arguments.paths as string[] | undefined) ?? [],
        argv: [...config.commands[mode]!, ...paths],
        env: mode === "full" ? env : { ...env, npm_config_cache: SANDBOX_NPM_CACHE },
        timeoutMs: config.timeoutSeconds * 1000, policy: deps.policy,
        ...(mode === "full" ? {} : { sandbox }),
      });
    },
  };
  const maxWait = Math.min(30, Math.max(0, deps.maxWaitSeconds ?? 30));
  const readPermission: CommandDefinition["permission"] = {
    effects: ["emit.event"], defaultDecision: "allow", resources: ["gate:session"],
    filesystem: "none", network: "none", cost: "none",
  };
  const wait: CommandDefinition<GateView> = {
    id: "gate/wait", title: "Wait for gate", description: `Wait up to ${maxWait} seconds for a session-owned gate. Returns state, mode, exit code, status line, bounded output tail and runtime log path (~/.dyfj/log/gate/<session-id>/<run-id>.log). Unknown ids disclose no other session's run.`,
    inputSchema: { type: "object", required: ["run"], properties: {
      run: { type: "string" }, wait_seconds: { type: "number", minimum: 0, description: `Capped at ${maxWait} seconds; defaults to zero.` },
    }, additionalProperties: false }, permission: readPermission,
    executor: call => runs.wait(sessionId, String(call.arguments.run), Math.min(maxWait, Number(call.arguments.wait_seconds ?? 0))),
  };
  const cancel: CommandDefinition<GateView> = {
    id: "gate/cancel", title: "Cancel gate", description: "Request termination of this session's run and its whole process group. Use gate/wait for the final state.",
    inputSchema: { type: "object", required: ["run"], properties: { run: { type: "string" } }, additionalProperties: false },
    permission: readPermission, executor: call => runs.cancel(sessionId, String(call.arguments.run)),
  };
  for (const command of [start, wait, cancel]) {
    // Worktree code controls output; record run metadata, never its output tail.
    command.redactResult = true;
    command.eventContent = (_error, result) => {
      if (result.isError) return "gate call failed";
      const view = result.result as GateView;
      return JSON.stringify({ command: command.id, run: view.run, mode: view.mode, paths: view.paths, state: view.state, exitCode: view.exitCode });
    };
    command.modelResult = result => JSON.stringify(result);
  }
  return [start, wait, cancel];
}
