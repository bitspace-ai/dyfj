import { describe, expect, test } from "vitest";
import { type BashRunner, buildSafeBashEnv, executeBash } from "./exec-tools";

// A canned runner so these tests never spawn a real process.
const cannedRunner = (
  stdout: string,
  stderr = "",
  code = 0,
  extra: { signal?: string | null; timedOut?: boolean } = {},
): BashRunner =>
() =>
  Promise.resolve({
    code,
    signal: extra.signal ?? null,
    stdout,
    stderr,
    timedOut: extra.timedOut ?? false,
  });

describe("executeBash", () => {
  test("returns exit status and stdout on success", async () => {
    const out = await executeBash("/work", "echo hi", {
      runner: cannedRunner("hi\n"),
    });
    expect(out).toBe("exit 0\nhi");
  });

  test("captures a non-zero exit and stderr", async () => {
    const out = await executeBash("/work", "false", {
      runner: cannedRunner("", "boom\n", 1),
    });
    expect(out).toContain("exit 1");
    expect(out).toContain("boom");
  });

  test("combines stdout and stderr", async () => {
    const out = await executeBash("/work", "x", {
      runner: cannedRunner("out\n", "err\n"),
    });
    expect(out).toContain("out");
    expect(out).toContain("err");
  });

  test("rejects an empty command without invoking the runner", async () => {
    let ran = false;
    const runner: BashRunner = () => {
      ran = true;
      return Promise.resolve({
        code: 0,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false,
      });
    };
    expect(await executeBash("/work", "   ", { runner })).toBe(
      "error: empty command",
    );
    expect(ran).toBe(false);
  });

  test("reports a timeout", async () => {
    const out = await executeBash("/work", "sleep 999", {
      timeoutMs: 50,
      runner: cannedRunner("", "", 137, { timedOut: true }),
    });
    expect(out).toMatch(/timed out after 50ms/);
  });

  test("truncates output past the byte cap", async () => {
    const out = await executeBash("/work", "yes", {
      maxBytes: 10,
      runner: cannedRunner("0123456789ABCDEF"),
    });
    expect(out).toContain("[truncated at 10 characters]");
  });

  test("surfaces a runner failure as an error result (never throws)", async () => {
    const runner: BashRunner = () => Promise.reject(new Error("spawn EACCES"));
    expect(await executeBash("/work", "x", { runner })).toMatch(
      /^error: cannot run command: spawn EACCES/,
    );
  });
});

describe("buildSafeBashEnv", () => {
  const SAFE = new Set([
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "TZ",
    "TMPDIR",
  ]);

  test("forwards only non-secret keys and never the projected secrets", () => {
    // Secrets set in the parent env must NOT be forwarded to bash (CWE-532).
    Deno.env.set("ANTHROPIC_API_KEY", "fixture-should-not-leak");
    Deno.env.set("DOLT_PASSWORD", "test-should-not-leak");
    Deno.env.set("DYFJ_WORKBENCH_API_KEY", "bearer-should-not-leak");
    try {
      const env = buildSafeBashEnv();
      for (const key of Object.keys(env)) {
        expect(SAFE.has(key)).toBe(true);
      }
      expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(env).not.toHaveProperty("DOLT_PASSWORD");
      expect(env).not.toHaveProperty("DYFJ_WORKBENCH_API_KEY");
      // PATH must be forwarded so commands still resolve.
      expect(env.PATH).toBeDefined();
    } finally {
      Deno.env.delete("ANTHROPIC_API_KEY");
      Deno.env.delete("DOLT_PASSWORD");
      Deno.env.delete("DYFJ_WORKBENCH_API_KEY");
    }
  });
});
