import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDevArgs, parseReplMessage, replArgs } from "./dyfj-dev.ts";

const ID = "01J0000000000000000000000A";

test("dev args: the socket and log from the launcher, and the REPL's own flags", () => {
  assert.deepStrictEqual(
    parseDevArgs(["--socket", "/s/dev.sock", "--log", "/l/dev.log", "--model", "m", "--fast", "--workspace", "/w"]),
    { socket: "/s/dev.sock", log: "/l/dev.log", repl: ["--model", "m", "--fast", "--workspace", "/w"], session: null },
  );
  assert.deepStrictEqual(
    parseDevArgs(["--socket", "/s", "--log", "/l", "--session", ID, "--approve-paid"]),
    { socket: "/s", log: "/l", repl: ["--approve-paid"], session: ID },
  );
});

test("dev args: anything the Rust REPL does not take is refused", () => {
  for (const args of [
    ["--log", "/l"],
    ["--socket", "/s"],
    ["--socket", "/s", "--log", "/l", "--tier", "1"],
    ["--socket", "/s", "--log", "/l", "-p", "hi"],
    ["--socket", "/s", "--log", "/l", "status"],
    ["--socket", "/s", "--log", "/l", "--model"],
    ["--socket", "/s", "--log", "/l", "--model", "--fast"],
  ]) {
    assert.throws(() => parseDevArgs(args), /dyfj dev/, args.join(" "));
  }
});

test("a re-exec resumes the session the REPL last reported", () => {
  assert.deepStrictEqual(replArgs(["--model", "m"], null), ["--model", "m"]);
  assert.deepStrictEqual(replArgs(["--model", "m"], ID), ["--model", "m", "--session", ID]);
});

test("REPL messages are parsed strictly", () => {
  assert.deepStrictEqual(parseReplMessage('{"type":"reload"}'), { type: "reload" });
  assert.deepStrictEqual(parseReplMessage(`{"type":"session","id":"${ID}"}`), { type: "session", id: ID });
  for (const line of [
    "nope",
    "[]",
    '{"type":"session"}',
    '{"type":"session","id":"x; rm -rf /"}',
    '{"type":"exit"}',
    `${"x".repeat(5000)}`,
  ]) {
    assert.deepStrictEqual(parseReplMessage(line), null, line.slice(0, 40));
  }
});
