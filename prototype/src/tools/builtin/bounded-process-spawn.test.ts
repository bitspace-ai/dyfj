import assert from "node:assert/strict";
import process from "node:process";
import { describe, it } from "node:test";
import {
  composeRuntimePolicy,
  type RuntimePolicy,
  SpawnRefusedError,
} from "../../config/mod.ts";
import { runBounded, runKill } from "./bounded-process.ts";

const posix = process.platform !== "win32";

function request(command: string) {
  return {
    command,
    args: [],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "" },
    timeoutMs: 5_000,
  };
}

describe("bounded process spawn policy", () => {
  it(
    "refuses a command outside the run policy by default",
    { skip: !posix },
    async () => {
      await assert.rejects(
        runBounded(request("/usr/bin/true")),
        (error: unknown) =>
          error instanceof SpawnRefusedError &&
          error.command === "/usr/bin/true",
      );
    },
  );

  it("runs a command the policy allows", { skip: !posix }, async () => {
    const policy: RuntimePolicy = {
      ...composeRuntimePolicy(),
      run: ["/usr/bin/true"],
    };
    const result = await runBounded(request("/usr/bin/true"), { policy });
    assert.strictEqual(result.code, 0);
  });

  it(
    "the kill runner reports unavailable when /bin/kill is outside the policy",
    { skip: !posix },
    async () => {
      const policy: RuntimePolicy = { ...composeRuntimePolicy(), run: ["git"] };
      assert.strictEqual(
        await runKill(["-0", "--", String(process.pid)], undefined, policy),
        "unavailable",
      );
    },
  );

  it("the kill runner signals through /bin/kill under the base policy", {
    skip: !posix,
  }, async () => {
    assert.strictEqual(
      await runKill(
        ["-0", "--", String(process.pid)],
        undefined,
        composeRuntimePolicy(),
      ),
      "delivered",
    );
  });
});
