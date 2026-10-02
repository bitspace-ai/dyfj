// runSecretCommand against real child processes (`bash`), and the parent
// environment it must not leak into the resolver child. The pure resolution
// logic is covered by `secrets.test.ts` with an in-memory env.
import {
  assertEquals,
  assertFalse,
  assertMatch,
  assertStrictEquals,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { runSecretCommand } from "./secrets.ts";

/** A real PATH so a `clearEnv` child can still find external binaries. */
const PATH_ENV = { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" };

describe("runSecretCommand (real subprocess)", () => {
  it("a spawn failure reason leaks neither the resolver path nor the pointer", async () => {
    // Assembled at runtime so the public-boundary scan never matches this
    // fixture as a home-directory path in tracked source.
    const privatePath = ["", "Users", "private-user", "secret-vault-tool", "op"]
      .join("/");
    const pointer = "op://PrivateVault/SecretItem/credential";
    const res = await runSecretCommand([privatePath, "read"], pointer, 2000);
    assertStrictEquals(res.ok, false);
    assertStrictEquals(
      res.reason,
      "cannot run the resolver command (not found or not permitted)",
    );
    // The operator-private path and the pointer must not appear in the reason.
    assertFalse(res.reason.includes("private-user"));
    assertFalse(res.reason.includes("secret-vault-tool"));
    assertFalse(res.reason.includes("PrivateVault"));
    assertFalse(res.reason.includes(pointer));
  });

  it("returns the trimmed stdout on a clean exit", async () => {
    const res = await runSecretCommand(
      ["bash", "-c", "printf 'resolved-value\n'"],
      "op://v/x/credential",
      2000,
      PATH_ENV,
    );
    assertEquals(res, { ok: true, value: "resolved-value" });
  });

  it("treats empty stdout as unavailable", async () => {
    const res = await runSecretCommand(
      ["bash", "-c", "true"],
      "op://v/x/credential",
      2000,
      PATH_ENV,
    );
    assertStrictEquals(res.ok, false);
    assertMatch(res.reason ?? "", /empty/);
  });

  it("reports the exit code on a non-zero exit (no captured output)", async () => {
    const res = await runSecretCommand(
      ["bash", "-c", "printf SHOULD_NOT_LEAK >&2; exit 4"],
      "op://v/x/credential",
      2000,
      PATH_ENV,
    );
    assertStrictEquals(res.ok, false);
    assertStrictEquals(res.reason, "resolver exited with code 4");
    assertFalse(res.reason.includes("SHOULD_NOT_LEAK"));
  });

  it("clearEnv isolates the child: an ambient var NOT in the passed env is absent", async () => {
    // Prove the resolver child does not inherit an ambient secret. bash echoes
    // $LEAKY_AMBIENT; the child is spawned clearEnv with only PATH, so it prints
    // the empty marker even though the parent process has the var set.
    Deno.env.set("LEAKY_AMBIENT", "super-secret");
    try {
      const res = await runSecretCommand(
        ["bash", "-c", 'printf "[%s]" "${LEAKY_AMBIENT-}"'],
        "op://v/x/credential",
        2000,
        PATH_ENV,
      );
      assertEquals(res, { ok: true, value: "[]" });
    } finally {
      Deno.env.delete("LEAKY_AMBIENT");
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
    assertEquals(res, { ok: true, value: "from-secrets-env" });
  });
});

// The timeout case runs in a suite of its own. On timeout runSecretCommand
// kills the resolver and stops awaiting its output by design, so a stuck
// resolver can never hold the boot. Here the `sleep` grandchild keeps the piped
// stdout and stderr open for about 5 s, so the abandoned output read is still
// pending when the case ends. That is the behavior under test, so this suite
// opts out of both sanitizers; the other suites keep them.
describe({
  name: "runSecretCommand (real subprocess), abandoned resolver output",
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  it("times out without hanging on a slow resolver", async () => {
    const res = await runSecretCommand(
      ["bash", "-c", "sleep 5; printf LEAK"],
      "op://v/x/credential",
      150,
      PATH_ENV,
    );
    assertStrictEquals(res.ok, false);
    assertMatch(res.reason ?? "", /timed out/);
  });
});
