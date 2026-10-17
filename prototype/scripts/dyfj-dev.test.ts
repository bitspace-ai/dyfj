import assert from "node:assert/strict";
import process from "node:process";
import { test } from "node:test";
import { inFlightTurnsFrom, openOwnerOnlyLog, parseDevArgs, parseReplMessage, replArgs } from "./dyfj-dev.ts";

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

test("the runtime log is made owner-only even when it and its directory already exist open", async () => {
  const { chmod, mkdtemp, mkdir, writeFile, stat, rm, symlink, realpath } = await import("node:fs/promises");
  const { closeSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await realpath(await mkdtemp(join(tmpdir(), "dyfj-dev-log-")));
  try {
    const dir = join(root, "log");
    await mkdir(dir, { mode: 0o755 });
    await chmod(dir, 0o755);
    const log = join(dir, "runtime.log");
    await writeFile(log, "LOG-CONTENT-MARKER\n", { mode: 0o644 });
    await chmod(log, 0o644);
    closeSync(openOwnerOnlyLog(log));
    assert.deepStrictEqual((await stat(dir)).mode & 0o777, 0o700);
    assert.deepStrictEqual((await stat(log)).mode & 0o777, 0o600);

    const elsewhere = join(root, "elsewhere.log");
    await writeFile(elsewhere, "");
    const linked = join(dir, "linked.log");
    await symlink(elsewhere, linked);
    assert.throws(() => openOwnerOnlyLog(linked), (error: Error) => {
      assert.deepStrictEqual(error.message, `the runtime log ${linked} cannot be made owner-only (ELOOP)`);
      return true;
    });

    // A log another account owns is refused, as root is not at hand here, by
    // naming a different owner.
    const owner = (process.getuid?.() ?? 0) + 1;
    assert.throws(() => openOwnerOnlyLog(log, owner), (error: Error) => {
      assert.deepStrictEqual(error.message, `the runtime log ${log} cannot be made owner-only`);
      assert.doesNotMatch(error.message, /LOG-CONTENT-MARKER/);
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("in-flight turns are read from the server's own runtime/status response", async () => {
  const { buildRuntimeHandlers } = await import("../src/server/rpc/runtime.ts");
  const status = (activity?: { clients: number; inFlightTurns: number }) =>
    buildRuntimeHandlers({
      loadModels: async () => [],
      ...(activity === undefined ? {} : { activity: () => activity }),
    })["runtime/status"]!(undefined, undefined as never);
  assert.deepStrictEqual(inFlightTurnsFrom(await status({ clients: 2, inFlightTurns: 3 })), 3);
  assert.deepStrictEqual(inFlightTurnsFrom(await status({ clients: 1, inFlightTurns: 0 })), 0);
  // A runtime that does not count its turns says nothing to wait for.
  assert.deepStrictEqual(inFlightTurnsFrom(await status()), null);
  for (const odd of [undefined, null, 3, {}, { runtime: null }, { runtime: { inFlightTurns: "1" } }]) {
    assert.deepStrictEqual(inFlightTurnsFrom(odd), null, JSON.stringify(odd));
  }
});

test("the session message parses exactly as the Rust REPL writes it", () => {
  // The bytes `dev_control.rs` sends for a session (its test pins them).
  assert.deepStrictEqual(
    parseReplMessage('{"id":"01J0000000000000000000000A","type":"session"}'),
    { type: "session", id: "01J0000000000000000000000A" },
  );
  assert.deepStrictEqual(parseReplMessage('{"type":"reload"}'), { type: "reload" });
});
