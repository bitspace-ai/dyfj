/** Foreground disposable runtime, with a cleared child environment. */
import { spawnSync } from "node:child_process";
import type { Stats } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import process from "node:process";
import { z } from "zod";
import type { ModelScript } from "../testing/servers/model-server.ts";
import {
  drain,
  prototypeRoot,
  spawnCli,
  startDisposableRuntime,
  stopChild,
} from "./disposable-runtime.ts";

const usage = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
});
const replies = z.array(z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    text: z.string(),
    usage: usage.optional(),
  }),
  z.object({
    kind: z.literal("tool"),
    tool: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()),
    usage: usage.optional(),
  }),
  z.object({ kind: z.literal("hold"), text: z.string() }),
])).min(1);

/** One reply per request, then repeat the last reply. */
export function jsonScript(value: unknown): ModelScript {
  const script = replies.parse(value);
  let index = 0;
  return () => script[Math.min(index++, script.length - 1)];
}
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
export function shellExports(env: Record<string, string>): string {
  return Object.entries(env).map(([key, value]) =>
    `export ${key}=${quote(value)}\n`
  ).join("");
}
const PROFILE = {
  name: "scratch",
  env: {
    DYFJ_PERMISSION_LEVEL: "strict",
    DYFJ_WORKBENCH_MODEL: "scratch-local",
  },
};
const MODEL = {
  slug: "scratch-local",
  displayName: "Scratch Local",
  tier: 0 as const,
  contextWindow: 32768,
  maxOutputTokens: 1024,
  costInput: 0,
  costOutput: 0,
  capabilities: ["text"],
};
interface State {
  pid: number;
  root: string;
  socket: string;
  commit: string;
  upCommand: string;
  env: Record<string, string>;
  processes: number[];
}
export function assertPrivateStateFile(
  info: Pick<Stats, "uid" | "mode">,
  uid: number | undefined,
): void {
  if (uid === undefined || info.uid !== uid) {
    throw new Error("scratch state file owner must be the current user");
  }
  if ((info.mode & 0o7777) !== 0o600) {
    throw new Error("scratch state file mode must be 0600");
  }
}

async function loadState(path: string, forShutdown: boolean): Promise<State> {
  const file = await open(path, "r");
  let state: State;
  try {
    if (forShutdown) {
      assertPrivateStateFile(await file.stat(), process.getuid?.());
    }
    state = JSON.parse(await file.readFile("utf8")) as State;
  } finally {
    await file.close();
  }
  if (
    path !== `${state.root}/state.json` ||
    !/^\/tmp\/dyfj_s_[A-Za-z0-9]+$/.test(state.root) ||
    !Number.isSafeInteger(state.pid) || state.pid < 2 ||
    state.socket !== `${state.root}/scratch/wb.sock`
  ) {
    throw new Error("invalid scratch state");
  }
  return state;
}
async function up(scriptFile?: string): Promise<void> {
  const script = jsonScript(
    scriptFile
      ? JSON.parse(await readFile(scriptFile, "utf8"))
      : [{ kind: "text", text: "Scratch reply." }],
  );
  const root = await mkdtemp("/tmp/dyfj_s_");
  await mkdir(`${root}/tmp`);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  let runtime: Awaited<ReturnType<typeof startDisposableRuntime>> | undefined;
  try {
    runtime = await startDisposableRuntime({
      models: [MODEL],
      script,
      workspaceFiles: {},
      root,
      fixtureUnderRoot: true,
      signal: controller.signal,
      containChildren: true,
    });
    const socket = await runtime.server(PROFILE);
    const git = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: prototypeRoot,
      env: runtime.launch.baseEnv,
      encoding: "utf8",
    });
    if (git.status !== 0) throw new Error("cannot identify checkout commit");
    const state: State = {
      pid: process.pid,
      root,
      socket,
      commit: git.stdout.trim(),
      upCommand: `node scripts/scratch-runtime.ts up${
        scriptFile ? ` --script ${quote(scriptFile)}` : ""
      }`,
      env: {
        ...runtime.environments.get(PROFILE.name)!,
        DYFJ_WORKSPACE: runtime.workspace,
      },
      processes: [process.pid, runtime.fixture.pid, ...runtime.pids],
    };
    if (!controller.signal.aborted) {
      await writeFile(`${root}/state.json`, JSON.stringify(state, null, 2), {
        mode: 0o600,
      });
      process.stdout.write(`${root}/state.json\n`);
      await new Promise<void>((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
        if (controller.signal.aborted) resolve();
      });
    }
  } finally {
    try {
      await runtime?.close();
    } finally {
      await rm(root, { recursive: true, force: true });
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
    }
  }
}
async function cli(
  state: State,
  args: string[],
  input?: string,
): Promise<string> {
  const child = spawnCli(
    {
      root: state.root,
      workspace: state.env.DYFJ_WORKSPACE,
      baseEnv: state.env,
      dbEnv: {},
      modelHost: "",
      linearUrl: "",
    },
    state.socket,
    args,
  );
  const out: string[] = [];
  const err: string[] = [];
  const drained = Promise.all([
    drain(child.process.stdout!, out),
    drain(child.process.stderr!, err),
  ]);
  child.process.stdin!.end(input);
  const timeout = setTimeout(() => {
    void stopChild(child);
  }, 60_000);
  try {
    const code = await child.closed;
    await drained;
    if (code !== 0) throw new Error(`dyfj exited ${code}: ${err.join("")}`);
    return out.join("");
  } finally {
    clearTimeout(timeout);
  }
}
async function exec(state: State, prompt: string): Promise<void> {
  const result = await cli(state, ["exec", "--json", prompt]);
  const turn = JSON.parse(result) as {
    sessionId: string;
    text: string;
    receipt: string;
  };
  const commands =
    `${state.upCommand}\nnode scripts/scratch-runtime.ts env --state ${
      quote(`${state.root}/state.json`)
    }\ndyfj exec --json ${quote(prompt)}`;
  const evidence = `Commit: ${state.commit}\nCommands:\n${commands}\n` +
    `Reply:\n${turn.text}\nReceipt (exec --json):\n${turn.receipt}\n`;
  await writeFile(`${state.root}/evidence.txt`, evidence, { mode: 0o600 });
  process.stdout.write(result);
}
async function down(state: State): Promise<void> {
  let evidence: string;
  try {
    evidence = await readFile(`${state.root}/evidence.txt`, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    evidence = `Commit: ${state.commit}\n` +
      "No recorded turn; use scratch-runtime exec to capture evidence.\n";
  }
  process.kill(state.pid, "SIGTERM");
  const deadline = Date.now() + 30_000;
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  };
  while (true) {
    try {
      await stat(state.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!state.processes.some(alive)) break;
    }
    if (Date.now() > deadline) {
      throw new Error("scratch runtime did not finish cleanup");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  process.stdout.write(
    `Disposable runtime evidence\n${evidence}Command: ` +
      "node scripts/scratch-runtime.ts down --state " +
      `${quote(`${state.root}/state.json`)}\nTeardown: complete\n`,
  );
}
async function main(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (
    command === "up" &&
    (rest.length === 0 || rest.length === 2 && rest[0] === "--script")
  ) return up(rest[1]);
  if (
    ["env", "exec", "down", "evidence"].includes(command) &&
    rest[0] === "--state" && rest[1]
  ) {
    const state = await loadState(rest[1], command === "down");
    if (command === "env" && rest.length === 2) {
      process.stdout.write(shellExports(state.env));
      return;
    }
    if (command === "exec" && rest.length === 3) return exec(state, rest[2]);
    if (command === "down" && rest.length === 2) return down(state);
    if (command === "evidence" && rest.length === 2) {
      process.stdout.write(
        await readFile(`${state.root}/evidence.txt`, "utf8"),
      );
      return;
    }
  }
  throw new Error(
    "usage: scratch-runtime.ts up [--script replies.json] | " +
      "env|down|evidence --state PATH | exec --state PATH PROMPT",
  );
}
if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(String(error));
    process.exitCode = 1;
  });
}
