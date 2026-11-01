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

test("exports quote shell metacharacters without evaluating them", () => {
  equal(
    shellExports({ HOME: "/tmp/a'b$(false)`false`" }),
    "export HOME='/tmp/a'\\''b$(false)`false`'\n",
  );
});
