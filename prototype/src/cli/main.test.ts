import assert from "node:assert/strict";
import process from "node:process";
import { describe, it } from "node:test";
import { fakeIo } from "../../testing/fakes/fake-io.ts";
import { HELP, parseArgs } from "./args.ts";
import { main } from "./main.ts";

describe("main usage errors", () => {
  it("a garbage --session exits 2 via the usage-error path", async () => {
    const { io, stderr } = fakeIo();
    const code = await main(["--session", "garbage-value"], io);
    assert.strictEqual(code, 2);
    assert.match(stderr[0], /^dyfj: --session /);
    assert.ok(
      stderr[0].includes("dyfj sessions"),
      `expected stderr[0] to include "dyfj sessions"`,
    );
    // The tidy path: usage message + help, never a stack trace.
    assert.doesNotMatch(stderr.join("\n"), /^\s+at /m);
  });
});

describe("main --parse-check", () => {
  const silentIo = {
    out: () => {},
    err: () => {},
    readLine: () => Promise.resolve(null),
    close: () => {},
  };
  it("a valid invocation exits 0", async () => {
    assert.strictEqual(await main(["--parse-check", "status"], silentIo), 0);
    assert.strictEqual(await main(["--parse-check"], silentIo), 0);
  });
  it("a parser rejection exits 2", async () => {
    assert.strictEqual(await main(["--parse-check", "--bogus"], silentIo), 2);
    assert.strictEqual(
      await main(["--parse-check", "--tier", "3"], silentIo),
      2,
    );
  });
  it("a parser THROW also exits 2 — the contract is 0/2, not 0/2/crash", async () => {
    // normalizeSessionRef throws on an invalid ref rather than returning a
    // parse error; parse-check absorbs either rejection shape.
    assert.strictEqual(
      await main(["--parse-check", "--session", "garbage-value"], silentIo),
      2,
    );
  });
});

describe("main --freshness-probe is launcher-internal", () => {
  function capturingIo() {
    const err: string[] = [];
    return {
      err,
      io: {
        out: () => {},
        err: (line: string) => err.push(line),
        readLine: () => Promise.resolve(null),
        close: () => {},
      },
    };
  }

  it("refuses outside the launcher's invocation context", async () => {
    const saved = process.env.DYFJ_PROTOTYPE_ROOT;
    delete process.env.DYFJ_PROTOTYPE_ROOT;
    try {
      const { io, err } = capturingIo();
      assert.strictEqual(await main(["--freshness-probe"], io), 2);
      assert.match(err.join("\n"), /--freshness-probe is launcher-internal/);
    } finally {
      if (saved !== undefined) process.env.DYFJ_PROTOTYPE_ROOT = saved;
    }
  });

  it("refuses any argument but --socket <path>", async () => {
    const saved = process.env.DYFJ_PROTOTYPE_ROOT;
    process.env.DYFJ_PROTOTYPE_ROOT = "/nonexistent/prototype";
    try {
      const { io } = capturingIo();
      assert.strictEqual(
        await main(["--freshness-probe", "--model", "x"], io),
        2,
      );
      assert.strictEqual(await main(["--freshness-probe", "--socket"], io), 2);
    } finally {
      if (saved === undefined) delete process.env.DYFJ_PROTOTYPE_ROOT;
      else process.env.DYFJ_PROTOTYPE_ROOT = saved;
    }
  });

  it("is not in --help, and the ordinary parser rejects it", () => {
    assert.ok(!HELP.includes("--freshness-probe"));
    assert.ok(parseArgs(["status", "--freshness-probe"]).error);
  });
});
