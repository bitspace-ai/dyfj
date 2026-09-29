// The REPL's `/idea` and `/packet` commands on the `unix: false` path, which
// keeps ideas and packets in a registry the REPL session owns instead of
// asking the engine.
import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  type CliConfig,
  type ConnectFn,
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
  assertEquals(await handler(line, local, io, state, noSocket), true);
  return [...stdout, ...stderr].join("\n");
}

Deno.test("/idea and /packet share the REPL session's registry", async () => {
  const state = session();
  const marked = await run("/idea mark Local idea", state);
  const ideaId = /marked idea \[([^\]]+)\]/.exec(marked)?.[1];
  assertEquals(typeof ideaId, "string");
  assertStringIncludes(await run("/idea list", state), "Local idea");
  assertStringIncludes(
    await run(`/packet draft ${ideaId} --title Local packet`, state),
    "# Work Packet: Local packet",
  );
  assertStringIncludes(await run("/packet list", state), "Local packet");
});

Deno.test("another REPL session starts with an empty registry", async () => {
  await run("/idea mark First session idea", session());
  assertStringIncludes(
    await run("/idea list", session()),
    "no ideas marked for session 01LOCAL_SESSION",
  );
});
