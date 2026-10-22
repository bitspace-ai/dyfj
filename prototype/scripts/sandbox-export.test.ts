// The isolated machine's patch export: the Mac asks the machine for the
// workspace's commits since a base as one mbox, read through a bounded pipe and
// checked before it is written. These tests pin the command and the checks.
// The round trip (export from the machine, `git am` on the Mac) runs from the
// Mac, in the operator's UAT, not in the in-machine acceptance script.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const exportModule = () => import("./sandbox-export.ts");

describe("the export command", () => {
  it("runs format-patch in an executor sandbox with git's program-running config off", async () => {
    const { exportCommand } = await exportModule();
    assert.deepStrictEqual(exportCommand("dyfj-l8", "main"), [
      "orb",
      "-m",
      "dyfj-l8",
      "-u",
      "root",
      "env",
      "-i",
      "PATH=/usr/local/bin:/usr/bin:/bin",
      "HOME=/tmp",
      "GIT_CONFIG_NOSYSTEM=1",
      "/usr/libexec/dyfj/dyfj-sandbox",
      "run",
      "--plan",
      "/etc/dyfj/l8/executor.plan.json",
      "--cwd",
      "/work",
      "--",
      "git",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.pager=cat",
      "format-patch",
      "--stdout",
      "--no-ext-diff",
      "--no-textconv",
      "main..HEAD",
      "--",
    ]);
  });

  it("accepts a base with ancestry suffixes", async () => {
    const { exportCommand } = await exportModule();
    assert.strictEqual(exportCommand("dyfj-l8", "HEAD~1").at(-2), "HEAD~1..HEAD");
    assert.strictEqual(exportCommand("dyfj-l8", "main^").at(-2), "main^..HEAD");
  });

  it("exports every commit when there is no base", async () => {
    const { exportCommand } = await exportModule();
    assert.deepStrictEqual(exportCommand("dyfj-l8", null).slice(-3), ["--root", "HEAD", "--"]);
  });

  for (const base of ["-x", "--output=/tmp/x", "main..x", "a b", "", "main;id", "^HEAD", "HEAD~x"]) {
    it(`refuses the base ${JSON.stringify(base)}`, async () => {
      const { exportCommand } = await exportModule();
      assert.throws(() => exportCommand("dyfj-l8", base), /base/);
    });
  }

  it("refuses a machine name that is not a plain name", async () => {
    const { exportCommand } = await exportModule();
    assert.throws(() => exportCommand("-m", "main"), /machine/);
  });
});

describe("the mbox check", () => {
  const PATCH = Buffer.from(
    "From 3a9580b Mon Sep 17 00:00:00 2001\nFrom: L8 <l8@example.invalid>\nSubject: [PATCH] L8: harmless edit\n\n---\n",
  );

  it("accepts a format-patch mbox", async () => {
    const { checkMbox } = await exportModule();
    assert.deepStrictEqual(checkMbox(PATCH), { patches: 1 });
  });

  it("refuses an empty export", async () => {
    const { checkMbox } = await exportModule();
    assert.throws(() => checkMbox(Buffer.alloc(0)), /no commits/);
  });

  it("refuses a separator with no patch headers after it", async () => {
    const { checkMbox } = await exportModule();
    assert.throws(
      () => checkMbox(Buffer.from("From deadbee garbage\n")),
      /not a format-patch mbox/,
    );
  });

  it("refuses output that is not an mbox", async () => {
    const { checkMbox } = await exportModule();
    assert.throws(() => checkMbox(Buffer.from("hello\n")), /not a format-patch mbox/);
  });

  it("refuses output that is not UTF-8 text", async () => {
    const { checkMbox } = await exportModule();
    assert.throws(
      () => checkMbox(Buffer.concat([PATCH, Buffer.from([0xff, 0xfe, 0x00])])),
      /not text/,
    );
  });
});

describe("the export run", () => {
  it("reports a command that cannot start as an error, not a crash", async () => {
    const { runExport } = await exportModule();
    await assert.rejects(
      runExport(["/nonexistent/dyfj-orb-missing"], 1_024),
      /cannot start the export command/,
    );
  });
});

describe("the bounded read", () => {
  it("collects a stream within the cap", async () => {
    const { readBounded } = await exportModule();
    const { Readable } = await import("node:stream");
    const out = await readBounded(Readable.from([Buffer.from("ab"), Buffer.from("c")]), 8);
    assert.strictEqual(out.toString(), "abc");
  });

  it("refuses a stream past the cap", async () => {
    const { readBounded } = await exportModule();
    const { Readable } = await import("node:stream");
    await assert.rejects(
      readBounded(Readable.from([Buffer.alloc(5), Buffer.alloc(5)]), 8),
      /exceeds 8 bytes/,
    );
  });
});
