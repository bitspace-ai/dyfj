import { test } from "node:test";
import { deepEqual, equal, throws } from "node:assert/strict";
import {
  assertPrivateStateFile,
  jsonScript,
  shellExports,
} from "./scratch-runtime.ts";

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
