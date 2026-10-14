// The REPL's `/idea` and `/packet` commands on the `unix: false` path, which
// keeps ideas and packets in a registry the REPL session owns instead of
// asking the engine.
import assert from "node:assert/strict";
import type { CliConfig } from "./cli/args.ts";
import type { ConnectFn } from "./cli/io.ts";
import {
  handleReplIdeaCommand,
  handleReplPacketCommand,
  type ReplSessionState,
} from "./cli.ts";
import { fakeIo } from "../testing/fakes/fake-io.ts";

const local: CliConfig = {
  socket: "/tmp/dyfj-test.sock",
  mode: "turn",
  color: false,
  unix: false,
};

const noSocket: ConnectFn = () => {
  throw new Error("the unix: false path must not connect");
};

function session(): ReplSessionState {
  return { sessionId: "01LOCAL_SESSION", turnCount: 1, sessionSpendUsd: 0 };
}

async function run(
  line: string,
  state: ReplSessionState,
): Promise<string> {
  const { io, stdout, stderr } = fakeIo();
  const handler = line.startsWith("/idea")
    ? handleReplIdeaCommand
    : handleReplPacketCommand;
  assert.deepStrictEqual(await handler(line, local, io, state, noSocket), true);
  return [...stdout, ...stderr].join("\n");
}

Deno.test("/idea and /packet share the REPL session's registry", async () => {
  const state = session();
  const marked = await run("/idea mark Local idea", state);
  const ideaId = /marked idea \[([^\]]+)\]/.exec(marked)?.[1];
  assert.deepStrictEqual(typeof ideaId, "string");
  assert.ok(
    (await run("/idea list", state)).includes("Local idea"),
    `expected await run("/idea list", state) to include "Local idea"`,
  );
  assert.ok(
    (await run(`/packet draft ${ideaId} --title Local packet`, state)).includes(
      "# Work Packet: Local packet",
    ),
    `expected await run(\`/packet draft \${ideaId} --title Local packet\`, state) to include "# Work Packet: Local packet"`,
  );
  assert.ok(
    (await run("/packet list", state)).includes("Local packet"),
    `expected await run("/packet list", state) to include "Local packet"`,
  );
});

Deno.test("another REPL session starts with an empty registry", async () => {
  await run("/idea mark First session idea", session());
  assert.ok(
    (await run("/idea list", session())).includes(
      "no ideas marked for session 01LOCAL_SESSION",
    ),
    `expected await run("/idea list", session()) to include "no ideas marked for session 01LOCAL_SESSION"`,
  );
});
