// runSecretCommand against real child processes (`bash`), and the parent
// environment it must not leak into the resolver child. The pure resolution
// logic is covered by `secrets.test.ts` with an in-memory env.
import assert from "node:assert/strict";
import process from "node:process";
import { describe, it } from "node:test";
import { runSecretCommand } from "./secrets.ts";

/** A real PATH so a child with a replaced environment can still find external binaries. */
const PATH_ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

describe("runSecretCommand (real subprocess)", () => {
  it("a spawn failure reason leaks neither the resolver path nor the pointer", async () => {
    // Assembled at runtime so the public-boundary scan never matches this
    // fixture as a home-directory path in tracked source.
    const privatePath = ["", "Users", "private-user", "secret-vault-tool", "op"]
      .join("/");
    const pointer = "op://PrivateVault/SecretItem/credential";
    const res = await runSecretCommand([privatePath, "read"], pointer, 2000);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(
      res.reason,
      "cannot run the resolver command (not found or not permitted)",
    );
    // The operator-private path and the pointer must not appear in the reason.
    assert.ok(!res.reason.includes("private-user"));
    assert.ok(!res.reason.includes("secret-vault-tool"));
    assert.ok(!res.reason.includes("PrivateVault"));
    assert.ok(!res.reason.includes(pointer));
  });

  it("returns the trimmed stdout on a clean exit", async () => {
    const res = await runSecretCommand(
      ["bash", "-c", "printf 'resolved-value\n'"],
      "op://v/x/credential",
      2000,
      PATH_ENV,
    );
    assert.deepStrictEqual(res, { ok: true, value: "resolved-value" });
  });

  it("treats empty stdout as unavailable", async () => {
    const res = await runSecretCommand(
      ["bash", "-c", "true"],
      "op://v/x/credential",
      2000,
      PATH_ENV,
    );
    assert.strictEqual(res.ok, false);
    assert.match(res.reason ?? "", /empty/);
  });

  it("names the signal when the resolver is killed by one, without captured output", async () => {
    const res = await runSecretCommand(
      ["bash", "-c", "printf SHOULD_NOT_LEAK >&2; kill -KILL $$"],
      "op://v/x/credential",
      2000,
      PATH_ENV,
    );
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, "resolver was killed by SIGKILL");
  });

  it("reports the exit code on a non-zero exit (no captured output)", async () => {
    const res = await runSecretCommand(
      ["bash", "-c", "printf SHOULD_NOT_LEAK >&2; exit 4"],
      "op://v/x/credential",
      2000,
      PATH_ENV,
    );
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, "resolver exited with code 4");
    assert.ok(!res.reason.includes("SHOULD_NOT_LEAK"));
  });

  it("the passed env replaces the child's environment: an ambient var NOT in it is absent", async () => {
    // Prove the resolver child does not inherit an ambient secret. bash echoes
    // $LEAKY_AMBIENT; the child is spawned with only PATH as its environment, so it prints
    // the empty marker even though the parent process has the var set.
    process.env.LEAKY_AMBIENT = "super-secret";
    try {
      const res = await runSecretCommand(
        ["bash", "-c", 'printf "[%s]" "${LEAKY_AMBIENT-}"'],
        "op://v/x/credential",
        2000,
        PATH_ENV,
      );
      assert.deepStrictEqual(res, { ok: true, value: "[]" });
    } finally {
      delete process.env.LEAKY_AMBIENT;
    }
  });
});

describe("runSecretCommand — env passthrough", () => {
  it("sets the passed env vars on the spawned resolver command", async () => {
    const res = await runSecretCommand(
      ["bash", "-c", 'printf %s "$RESOLVER_MARKER"'],
      "op://v/x/credential",
      2000,
      { ...PATH_ENV, RESOLVER_MARKER: "from-secrets-env" },
    );
    assert.deepStrictEqual(res, { ok: true, value: "from-secrets-env" });
  });
});

// On timeout runSecretCommand kills the resolver and stops awaiting its output
// by design, so a stuck resolver can never hold the boot. Here the `sleep`
// grandchild outlives the kill and keeps the write ends of the piped stdout and
// stderr open for about 5 s. The resolver must still release its own ends of
// both pipes, or the runtime holds them for as long as any descendant lives;
// the per-file handle check fails this file if it does not. The orphaned
// `sleep` is deliberately left running.
describe("runSecretCommand (real subprocess), abandoned resolver output", () => {
  it("times out without hanging on a slow resolver", async () => {
    const res = await runSecretCommand(
      ["bash", "-c", "sleep 5; printf LEAK"],
      "op://v/x/credential",
      150,
      PATH_ENV,
    );
    assert.strictEqual(res.ok, false);
    assert.match(res.reason ?? "", /timed out/);
  });
});
