import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import {
  bootFailureDetail,
  contentHashFrom,
  inFlightTurnsFrom,
  lastGoodArgs,
  localizePaths,
  openOwnerOnlyLog,
  parseDevArgs,
  parseReplMessage,
  readLogSince,
  reloadedEnv,
  replArgs,
} from "./dyfj-dev.ts";

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
  assert.deepStrictEqual(parseReplMessage('{"type":"rollback"}'), { type: "rollback" });
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

test("the booted code's hash is read from the server's own runtime/status response", async () => {
  const { buildRuntimeHandlers } = await import("../src/server/rpc/runtime.ts");
  const hash = `sha256:${"a".repeat(64)}`;
  const status = await buildRuntimeHandlers({
    loadModels: async () => [],
    fingerprint: { head: "unknown", contentHash: hash },
  })["runtime/status"]!(undefined, undefined as never);
  assert.strictEqual(contentHashFrom(status), hash);
  for (const odd of [undefined, null, {}, { runtime: {} }, { runtime: { fingerprint: { contentHash: 3 } } }]) {
    assert.strictEqual(contentHashFrom(odd), null, JSON.stringify(odd));
  }
});

test("the last good code runs from the snapshot with the runtime's own args", () => {
  assert.deepStrictEqual(
    lastGoodArgs(["--flag", "src/server/main.ts", "--autostarted"], ".dyfj-dev-last-good/server/main.ts"),
    ["--flag", ".dyfj-dev-last-good/server/main.ts", "--autostarted"],
  );
  assert.throws(() => lastGoodArgs(["--autostarted"], "x"), /server entry/);
});

test("the launcher's missing-entry error is a sentence that says what to look at", () => {
  assert.throws(
    () => lastGoodArgs(["--autostarted"], "x"),
    {
      message:
        "dyfj dev cannot run the last good code: the runtime's launch arguments do not " +
        "include the server entry src/server/main.ts.",
    },
  );
});

test("the REPL learns of a both-halves reload through its environment, and not from the shell", () => {
  assert.deepStrictEqual(reloadedEnv("1 file changed"), { DYFJ_DEV_RELOADED: "1 file changed" });
  assert.deepStrictEqual(reloadedEnv(undefined), { DYFJ_DEV_RELOADED: "" }, "an inherited value is overridden");
});

test("a failed boot's detail is its own log output, without the dev header", () => {
  const log = "── dyfj dev runtime at 2026-10-17T20:00:00Z, socket /s ──\nold run\n" +
    "── dyfj dev runtime at 2026-10-17T20:01:00Z, socket /s ──\n" +
    "file:///repo/prototype/src/engine/agent-loop.ts:3\nexport const x = ;\n" +
    "SyntaxError [ERR_INVALID_TYPESCRIPT_SYNTAX]: Expression expected\n";
  const offset = log.indexOf("── dyfj dev runtime at 2026-10-17T20:01");
  assert.strictEqual(
    bootFailureDetail(log, offset),
    "file:///repo/prototype/src/engine/agent-loop.ts:3\nexport const x = ;\n" +
      "SyntaxError [ERR_INVALID_TYPESCRIPT_SYNTAX]: Expression expected\n",
  );
});

test("host paths in a boot failure become repo-relative, and the home directory ~", () => {
  assert.strictEqual(
    localizePaths(
      "at file:///srv/op/dyfj/prototype/src/a.ts:3 and /srv/op/dyfj/core/x.rs, /srv/op/.npm",
      "/srv/op/dyfj",
      "/srv/op",
    ),
    "at prototype/src/a.ts:3 and core/x.rs, ~/.npm",
  );
});

test("a failed start's log is read from its offset, and only so far", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dyfj-log-"));
  try {
    const log = join(dir, "dev.log");
    const before = "x".repeat(100_000);
    await writeFile(log, `${before}── dyfj dev runtime at t, socket /s ──\nSyntaxError: bad\n${"y".repeat(200_000)}`);
    const text = readLogSince(log, Buffer.byteLength(before));
    assert.ok(text.startsWith("── dyfj dev runtime at t"), text.slice(0, 40));
    assert.ok(!text.includes("xxx"));
    assert.ok(Buffer.byteLength(text) <= 64 * 1024, `${Buffer.byteLength(text)} bytes`);
    assert.strictEqual(readLogSince(join(dir, "missing.log"), 0), "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
