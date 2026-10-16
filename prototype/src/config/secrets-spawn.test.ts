import assert from "node:assert/strict";
import process from "node:process";
import { test } from "node:test";
import { composeRuntimePolicy } from "./runtime-policy.ts";
import { runSecretCommand } from "./secrets.ts";

const posix = process.platform !== "win32";
const env = { PATH: process.env.PATH ?? "" };

test("the resolver runner refuses a binary outside the run policy", {
  skip: !posix,
}, async () => {
  // `printf` prints its operand, so an unguarded run would resolve a value.
  const result = await runSecretCommand(
    ["/usr/bin/printf", "%s"],
    "pointer",
    5_000,
    env,
  );
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.value, undefined);
  assert.match(result.reason ?? "", /not in the runtime's run policy/);
  assert.match(result.reason ?? "", /\[secrets\]\.command/);
  // Reasons reach the boot log and status, so the path stays out.
  assert.doesNotMatch(result.reason ?? "", /printf/);
});

test(
  "the resolver runner starts the binary once the policy holds [secrets].command",
  { skip: !posix },
  async () => {
    const result = await runSecretCommand(
      ["/usr/bin/printf", "%s"],
      "pointer",
      5_000,
      env,
      composeRuntimePolicy({
        secrets: { command: ["/usr/bin/printf"], inheritEnv: [] } as never,
      }),
    );
    assert.deepStrictEqual(result, { ok: true, value: "pointer" });
  },
);
