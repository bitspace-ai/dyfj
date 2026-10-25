// The isolated machine's runtime entry point: which delivered secret files
// become runtime environment variables. Synthetic canaries only.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deliverableNames, runServer, secretEnvironment } from "./sandbox-runtime.ts";

const CANARY = "canary-6f1d0c9e2b7a";
const files = (entries: Record<string, string | Buffer>) => (name: string) => {
  const value = entries[name];
  return value === undefined ? undefined : Buffer.isBuffer(value) ? value : Buffer.from(value);
};

describe("deliverable secret names", () => {
  it("are declared secrets the runtime policy grants", () => {
    const names = deliverableNames();
    assert.ok(names.includes("ANTHROPIC_API_KEY"));
    assert.ok(names.includes("OPENAI_API_KEY"));
    assert.ok(names.includes("DOLT_PASSWORD"));
  });

  it("exclude plain configuration and process variables", () => {
    const names = deliverableNames();
    for (const name of ["PATH", "HOME", "LD_PRELOAD", "DYFJ_SOCKET", "DOLT_USER", "NODE_OPTIONS"]) {
      assert.ok(!names.includes(name), name);
    }
  });
});

describe("the secret environment", () => {
  it("sets each delivered name from its file, byte for byte", () => {
    const set = secretEnvironment(["ANTHROPIC_API_KEY"], files({ ANTHROPIC_API_KEY: `${CANARY}\n` }), {});
    assert.deepStrictEqual(set, { ANTHROPIC_API_KEY: `${CANARY}\n` });
  });

  it("reads only the names it is given", () => {
    const asked: string[] = [];
    const set = secretEnvironment(["ANTHROPIC_API_KEY"], (name) => {
      asked.push(name);
      return Buffer.from(CANARY);
    }, {});
    assert.deepStrictEqual(asked, ["ANTHROPIC_API_KEY"]);
    assert.deepStrictEqual(Object.keys(set), ["ANTHROPIC_API_KEY"]);
  });

  it("keeps a leading byte-order mark", () => {
    const set = secretEnvironment(["DOLT_PASSWORD"], () => Buffer.from(`\uFEFF${CANARY}`), {});
    assert.strictEqual(set.DOLT_PASSWORD, `\uFEFF${CANARY}`);
  });

  it("treats an empty variable as unset", () => {
    const set = secretEnvironment(["DOLT_PASSWORD"], () => Buffer.from(CANARY), { DOLT_PASSWORD: "" });
    assert.deepStrictEqual(set, { DOLT_PASSWORD: CANARY });
  });

  it("never overwrites a non-empty variable", () => {
    const set = secretEnvironment(
      ["ANTHROPIC_API_KEY"],
      files({ ANTHROPIC_API_KEY: CANARY }),
      { ANTHROPIC_API_KEY: "already-set" },
    );
    assert.deepStrictEqual(set, {});
  });

  it("skips an absent or empty file", () => {
    const set = secretEnvironment(["OPENAI_API_KEY", "DOLT_PASSWORD"], files({ DOLT_PASSWORD: "" }), {});
    assert.deepStrictEqual(set, {});
  });

  it("refuses a value that is not text, by name and without the value", () => {
    for (const bytes of [Buffer.from([0xff, 0xfe]), Buffer.from(`${CANARY}\u0000x`)]) {
      assert.throws(
        () => secretEnvironment(["DOLT_PASSWORD"], () => bytes, {}),
        (error: Error) => error.message.startsWith("DOLT_PASSWORD:") && !error.message.includes(CANARY),
      );
    }
  });
});

describe("the server child", () => {
  it("takes the child's exit status", async () => {
    assert.strictEqual(await runServer(process.execPath, ["-e", "process.exit(7)"], {}), 7);
  });

  it("takes 128 plus the signal's number when a signal ends the child", async () => {
    const status = await runServer(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"], {});
    assert.strictEqual(status, 143);
  });

  it("exits 1 when the child cannot start, naming only the error code", async () => {
    const lines: string[] = [];
    const status = await runServer(
      "/nonexistent/dyfj-server-missing",
      [],
      { ANTHROPIC_API_KEY: CANARY },
      (line) => void lines.push(line),
    );
    assert.strictEqual(status, 1);
    assert.deepStrictEqual(lines, ["sandbox-runtime: cannot start the server (ENOENT)\n"]);
    assert.ok(!lines.join("").includes(CANARY));
  });
});
