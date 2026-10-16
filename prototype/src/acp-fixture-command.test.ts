// The command that starts the ACP fixture agent. The cases that run the
// fixture agent live in the ACP integration tests.
import assert from "node:assert/strict";
import process from "node:process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { fixtureAgentCommand } from "./acp-fixture-command.ts";

describe("the fixture agent's command", () => {
  const script = fileURLToPath(
    new URL("../scripts/acp-fixture-agent.ts", import.meta.url),
  );

  it("runs the script on this process's Node executable", () => {
    assert.deepStrictEqual(fixtureAgentCommand(), {
      command: process.execPath,
      args: [script],
    });
  });

  it("passes the script its arguments after the script path", () => {
    assert.deepStrictEqual(
      fixtureAgentCommand({ scriptArgs: ["--pid-file=/tmp/pid"] }),
      { command: process.execPath, args: [script, "--pid-file=/tmp/pid"] },
    );
  });
});
