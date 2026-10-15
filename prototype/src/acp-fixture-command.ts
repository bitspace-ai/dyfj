// The command that starts the ACP fixture agent (`scripts/acp-fixture-agent.ts`)
// on the runtime running this process. The fixture profile
// (`external-agent-runtime.ts`) and the ACP tests that start the fixture
// themselves build it here, so the fixture follows the product onto Node
// (decision D32).
import process from "node:process";
import { fileURLToPath } from "node:url";

/** A runtime the ACP fixture agent can run on. */
export type FixtureAgentRuntime = "deno" | "node";

/**
 * The runtime that `versions` (a `process.versions`) belongs to. The runtime
 * being replaced under decision D32 adds a `deno` entry there; Node has none.
 */
export function fixtureAgentRuntime(
  versions: Readonly<Record<string, string | undefined>> = process.versions,
): FixtureAgentRuntime {
  return versions.deno === undefined ? "node" : "deno";
}

const FIXTURE_AGENT_SCRIPT = fileURLToPath(
  new URL("../scripts/acp-fixture-agent.ts", import.meta.url),
);

/**
 * The command that starts the ACP fixture agent (`scripts/acp-fixture-agent.ts`)
 * on the runtime running this process, so the fixture follows the product
 * onto Node. Under Node it is `<node> <script> <scriptArgs>`. Under the runtime
 * being replaced it is that runtime's `run --cached-only` CLI with the
 * fixture's environment grant, then `grants`: the permission flags a caller
 * adds for the agent's optional files and commands (its pid file, method log,
 * `/bin/kill`, `bash`). Node runs the script without a permission sandbox, so
 * it takes no grants.
 */
export function fixtureAgentCommand(
  options: {
    grants?: readonly string[];
    scriptArgs?: readonly string[];
    runtime?: FixtureAgentRuntime;
  } = {},
): { command: string; args: string[] } {
  const scriptArgs = options.scriptArgs ?? [];
  if ((options.runtime ?? fixtureAgentRuntime()) === "node") {
    return {
      command: process.execPath,
      args: [FIXTURE_AGENT_SCRIPT, ...scriptArgs],
    };
  }
  return {
    command: process.execPath,
    args: [
      "run",
      "--cached-only",
      "--node-modules-dir=manual",
      `--config=${fileURLToPath(new URL("../deno.json", import.meta.url))}`,
      // NODE_V8_COVERAGE: that runtime's `node:child_process` reads it on
      // every spawn, which the agent's `/bin/kill` and `bash` children need.
      "--allow-env=ACP_FIXTURE_MODE,ACP_FIXTURE_ALLOWED,ACP_FIXTURE_AUTH_STATUS,ACP_FIXTURE_AMBIENT_VALUE,ANTHROPIC_API_KEY,DOLT_PASSWORD,DYFJ_MEMORY_MCP_TOKEN,SSH_AUTH_SOCK,NODE_V8_COVERAGE",
      ...(options.grants ?? []),
      FIXTURE_AGENT_SCRIPT,
      ...scriptArgs,
    ],
  };
}
