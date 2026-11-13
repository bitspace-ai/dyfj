import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import process from "node:process";
import { Readable, Writable } from "node:stream";
import { it } from "node:test";
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { guardedProtocolInput } from "./acp-client.ts";
import { fixtureAgentCommand } from "./acp-fixture-command.ts";
import { applyAcpToolPatch, finishAcpToolEvidence, newAcpToolEvidenceAccumulator } from "./acp-tool-evidence.ts";
import { prepareAcpToolEvidence } from "./acp-tool-evidence-record.ts";

it("passes fixture terminal metadata through the real protocol parser to capture", { timeout: 10_000 }, async (t) => {
  const command = fixtureAgentCommand();
  const child = spawn(command.command, command.args, {
    stdio: ["pipe", "pipe", "ignore"],
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  const closed = once(child, "close");
  const accumulator = newAcpToolEvidenceAccumulator();
  let activeSessionId: string | undefined;
  const protocolErrors: unknown[] = [];
  const input = guardedProtocolInput(
    Readable.toWeb(child.stdout),
    () => activeSessionId,
    (error) => protocolErrors.push(error),
  );
  try {
    await client({ name: "terminal-metadata-test" }).connectWith(
      ndJsonStream(Writable.toWeb(child.stdin), input.stream),
      async (context) => {
        await context.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        const session = await context.buildSession(process.cwd()).start();
        activeSessionId = session.sessionId;
        try {
          const prompt = session.prompt("FIXTURE_TERMINAL_COMMAND");
          const metas: unknown[] = [];
          for (;;) {
            const message = await session.nextUpdate();
            if (message.kind !== "session_update") break;
            const update = message.update as unknown as Record<string, unknown>;
            if (update._meta !== undefined) metas.push(update._meta);
            applyAcpToolPatch(accumulator, update);
          }
          await prompt;
          const terminal_id = "fixture-terminal-command";
          assert.deepStrictEqual(metas, [
            { terminal_output_delta: { data: "fixture ", terminal_id } },
            { terminal_output_delta: { data: "output\n", terminal_id } },
            { terminal_exit: { exit_code: 0, signal: null, terminal_id } },
          ]);
          assert.deepStrictEqual(protocolErrors, []);
          t.diagnostic("Verified: all three fixture _meta objects reached applyAcpToolPatch through guardedProtocolInput and the SDK parser.");
          const [record] = prepareAcpToolEvidence(finishAcpToolEvidence(accumulator)).calls;
          assert.equal(record.outcome, "recorded");
          assert.equal(record.toolResult, '{"exitCode":0,"output":"fixture output\\n"}');
        } finally {
          session.dispose();
        }
      },
    );
  } finally {
    child.kill();
    await closed;
  }
});
