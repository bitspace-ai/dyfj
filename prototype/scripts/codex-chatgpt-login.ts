// Signs the isolated Codex ChatGPT runner home in to ChatGPT: runs the pinned
// Codex adapter's `login` with the runner's environment and nothing else.
// The adapter runs on `DYFJ_NODE_PATH` when it is set, and otherwise on the
// Node executable running this script.
import { spawn, type SpawnOptions } from "node:child_process";
import process from "node:process";
import type { AcpExecutionProfile } from "../src/acp-client.ts";
import { DomainError } from "../src/contract/mod.ts";
import {
  codexChatGptProfile,
  type CodexChatGptProfileOptions,
} from "../src/external-agent-runtime.ts";

const USAGE =
  "usage: npm run codex-chatgpt-login\n\nSigns the isolated Codex ChatGPT runner home (~/.dyfj/runner-homes/codex-chatgpt)\nin to ChatGPT through the pinned Codex adapter. The adapter runs on\nDYFJ_NODE_PATH when it is set, and otherwise on the Node running this script.";

/** What a login run needs from its process; the tests supply each one. */
export interface CodexLoginDeps {
  args: readonly string[];
  cwd: string;
  /** The value of `DYFJ_NODE_PATH`, unset or empty when absent. */
  nodePathEnv: string | undefined;
  /** The Node executable running the login, the fallback for the adapter. */
  execPath: string;
  buildProfile: (
    workspace: string,
    options: CodexChatGptProfileOptions,
  ) => Promise<AcpExecutionProfile>;
  spawn: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => {
    once(event: "error", listener: (error: Error) => void): unknown;
    once(event: "exit", listener: (code: number | null) => void): unknown;
  };
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

/**
 * Runs the login and resolves to the exit status: the adapter's own, or 1
 * when the profile cannot be built or the adapter cannot be started. A
 * profile failure prints its fixed diagnostic; a start failure prints only
 * the error code, never the path.
 */
export async function runCodexChatGptLogin(
  deps: CodexLoginDeps,
): Promise<number> {
  if (deps.args.includes("--help")) {
    deps.stdout(USAGE);
    return 0;
  }
  let profile: AcpExecutionProfile;
  try {
    profile = await deps.buildProfile(deps.cwd, {
      nodePath: deps.nodePathEnv || deps.execPath,
      toolchainPath: "",
      rustupHome: "",
    });
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    deps.stderr(`dyfj: codex-chatgpt-login: ${error.message}`);
    return 1;
  }
  const environment = { ...profile.environment };
  delete environment.NO_BROWSER;

  return await new Promise<number>((resolve) => {
    let child: ReturnType<CodexLoginDeps["spawn"]>;
    const startFailed = (error: unknown) => {
      const code = (error as { code?: unknown }).code;
      deps.stderr(
        `dyfj: codex-chatgpt-login could not start the Codex adapter${
          typeof code === "string" ? ` (${code})` : ""
        }`,
      );
      resolve(1);
    };
    try {
      child = deps.spawn(profile.command, [...profile.args, "login"], {
        cwd: profile.workspace,
        env: environment,
        stdio: "inherit",
      });
    } catch (error) {
      startFailed(error);
      return;
    }
    child.once("error", startFailed);
    child.once("exit", (exitCode) => resolve(exitCode ?? 1));
  });
}

if (import.meta.main) {
  process.exit(
    await runCodexChatGptLogin({
      args: process.argv.slice(2),
      cwd: process.cwd(),
      nodePathEnv: process.env.DYFJ_NODE_PATH,
      execPath: process.execPath,
      buildProfile: codexChatGptProfile,
      spawn: (command, args, options) => spawn(command, args, options),
      stdout: (line) => console.log(line),
      stderr: (line) => console.error(line),
    }),
  );
}
