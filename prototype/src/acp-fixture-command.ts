// The command that starts the ACP fixture agent (`scripts/acp-fixture-agent.ts`)
// on the Node executable running this process. The fixture profile
// (`external-agent-runtime.ts`) and the ACP tests that start the fixture
// themselves build it here, so the fixture runs on the product's runtime
// (decision D32).
import process from "node:process";
import { fileURLToPath } from "node:url";

const FIXTURE_AGENT_SCRIPT = fileURLToPath(
  new URL("../scripts/acp-fixture-agent.ts", import.meta.url),
);

/**
 * `<node> <script> <scriptArgs>`: the fixture agent on this process's Node
 * executable, with no permission sandbox.
 */
export function fixtureAgentCommand(
  options: { scriptArgs?: readonly string[] } = {},
): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [FIXTURE_AGENT_SCRIPT, ...(options.scriptArgs ?? [])],
  };
}
