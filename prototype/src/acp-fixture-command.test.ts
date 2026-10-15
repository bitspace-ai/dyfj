// The command that starts the ACP fixture agent, on each runtime. The cases
// that run the fixture agent live in the ACP integration tests.
import assert from "node:assert/strict";
import process from "node:process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  fixtureAgentCommand,
  fixtureAgentRuntime,
} from "./acp-fixture-command.ts";

describe("the fixture agent's command", () => {
  const script = fileURLToPath(
    new URL("../scripts/acp-fixture-agent.ts", import.meta.url),
  );
  const config = fileURLToPath(new URL("../deno.json", import.meta.url));

  it("names the runtime from its process.versions", () => {
    assert.strictEqual(
      fixtureAgentRuntime({ node: "24.2.0", deno: "2.9.6" }),
      "deno",
    );
    assert.strictEqual(fixtureAgentRuntime({ node: "26.11.1" }), "node");
  });

  it("follows the runtime running this file, which is Node", () => {
    assert.strictEqual(fixtureAgentRuntime(), "node");
    assert.deepStrictEqual(
      fixtureAgentCommand({ scriptArgs: ["--pid-file=/tmp/pid"] }),
      fixtureAgentCommand({
        runtime: "node",
        scriptArgs: ["--pid-file=/tmp/pid"],
      }),
    );
  });

  it("runs the script directly under Node, which takes no grants", () => {
    assert.deepStrictEqual(
      fixtureAgentCommand({
        runtime: "node",
        grants: ["--allow-run=/bin/kill"],
        scriptArgs: ["--pid-file=/tmp/pid"],
      }),
      { command: process.execPath, args: [script, "--pid-file=/tmp/pid"] },
    );
  });

  it("runs the script through the replaced runtime's CLI with its grants", () => {
    assert.deepStrictEqual(
      fixtureAgentCommand({
        runtime: "deno",
        grants: ["--allow-run=/bin/kill", "--allow-write=/tmp/pid"],
        scriptArgs: ["--pid-file=/tmp/pid"],
      }),
      {
        command: process.execPath,
        args: [
          "run",
          "--cached-only",
          "--node-modules-dir=manual",
          `--config=${config}`,
          "--allow-env=ACP_FIXTURE_MODE,ACP_FIXTURE_ALLOWED,ACP_FIXTURE_AUTH_STATUS,ACP_FIXTURE_AMBIENT_VALUE,ANTHROPIC_API_KEY,DOLT_PASSWORD,DYFJ_MEMORY_MCP_TOKEN,SSH_AUTH_SOCK,NODE_V8_COVERAGE",
          "--allow-run=/bin/kill",
          "--allow-write=/tmp/pid",
          script,
          "--pid-file=/tmp/pid",
        ],
      },
    );
  });
});
