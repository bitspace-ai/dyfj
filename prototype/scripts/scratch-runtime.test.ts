import { test } from "node:test";
import { deepEqual, equal, rejects, throws } from "node:assert/strict";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  assertPrivateStateFile,
  assertRuntimeCommand,
  jsonScript,
  loadScript,
  shellExports,
} from "./scratch-runtime.ts";

test("an empty --script path is refused, not replaced by the default", async () => {
  await rejects(loadScript(""));
});

test("shutdown refuses a PID whose command is not this runtime's up", () => {
  const script = fileURLToPath(
    new URL("./scratch-runtime.ts", import.meta.url),
  );
  assertRuntimeCommand(`${process.execPath} ${script} up`);
  assertRuntimeCommand("node scripts/scratch-runtime.ts up\n");
  assertRuntimeCommand("node scripts/scratch-runtime.ts up --script r.json");
  for (const command of [
    "node unrelated.ts",
    "node scripts/scratch-runtime.ts down",
    "node scripts/scratch-runtime.ts upper",
    "node /other/scripts/scratch-runtime.ts up",
    "echo node scripts/scratch-runtime.ts up",
    "",
  ]) {
    throws(() => assertRuntimeCommand(command), /runtime supervisor/);
  }
});

test("shutdown requires the current owner and mode 0600", () => {
  assertPrivateStateFile({ uid: 501, mode: 0o100600 }, 501);
  throws(
    () => assertPrivateStateFile({ uid: 502, mode: 0o100600 }, 501),
    /owner/,
  );
  throws(
    () => assertPrivateStateFile({ uid: 501, mode: 0o100644 }, 501),
    /0600/,
  );
  throws(
    () => assertPrivateStateFile({ uid: 501, mode: 0o104600 }, 501),
    /0600/,
  );
  throws(
    () => assertPrivateStateFile({ uid: 501, mode: 0o100600 }, undefined),
    /owner/,
  );
});

test("JSON scripts repeat replies and reject malformed tool calls", () => {
  const script = jsonScript([{ kind: "text", text: "first" }, {
    kind: "text",
    text: "last",
  }]);
  deepEqual(
    [script({}), script({}), script({})].map((r) =>
      r.kind === "text" && r.text
    ),
    ["first", "last", "last"],
  );
  throws(() => jsonScript([]));
  throws(() => jsonScript([{ kind: "tool", tool: "bash" }]));
  throws(() =>
    jsonScript([{
      kind: "text",
      text: "ok",
      usage: { promptTokens: -1, completionTokens: 1 },
    }])
  );
});

test("JSON scripts accept reasoning, finish and direct wire names", () => {
  const replies = [
    {
      kind: "text", text: "", reasoning: "Thinking", reasoningTokens: 5,
      finish: "length", usage: { promptTokens: 10, completionTokens: 5 },
    },
    { kind: "text", text: "done", finish: "stop" },
    { kind: "tool", tool: "file.read", arguments: {}, reasoning: "Read it", reasoningTokens: 0 },
    { kind: "tool", wireName: "unoffered.tool!", arguments: {}, reasoning: "Call it", reasoningTokens: 2 },
  ];
  const script = jsonScript(replies);
  deepEqual(replies.map(() => script({})), replies);
  for (const reply of [
    { kind: "tool", tool: "", arguments: {} },
    { kind: "tool", wireName: "", arguments: {} },
    { kind: "tool", arguments: {} },
    { kind: "tool", tool: "file.read", wireName: "file_read", arguments: {} },
    { kind: "text", text: "", finish: "tool_calls" },
    { kind: "text", text: "", reasoningTokens: -1 },
    { kind: "tool", tool: "file.read", arguments: {}, reasoningTokens: 1.5 },
  ]) {
    throws(() => jsonScript([reply]));
  }
});

test("exports quote shell metacharacters without evaluating them", () => {
  equal(
    shellExports({ HOME: "/tmp/a'b$(false)`false`" }),
    "export HOME='/tmp/a'\\''b$(false)`false`'\n",
  );
});
