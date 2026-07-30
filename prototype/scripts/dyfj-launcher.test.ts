import { describe, expect, test } from "vitest";

const LAUNCHER = new URL("./dyfj-launcher.sh", import.meta.url).pathname;
const COMPILED_BIN = new URL("../dist/dyfj-bin", import.meta.url).pathname;

async function hasCompiledBin(): Promise<boolean> {
  return await Deno.stat(COMPILED_BIN).then(() => true).catch(() => false);
}

async function hasFreshCompiledBin(): Promise<boolean> {
  const source = new URL("../src/cli.ts", import.meta.url).pathname;
  const [compiledStat, sourceStat, launcherStat] = await Promise.all([
    Deno.stat(COMPILED_BIN).catch(() => null),
    Deno.stat(source).catch(() => null),
    Deno.stat(LAUNCHER).catch(() => null),
  ]);
  if (!compiledStat) return false;
  const compiledMtime = compiledStat.mtime?.getTime();
  if (compiledMtime === undefined) return false;
  const sourceMtime = sourceStat?.mtime?.getTime();
  if (sourceMtime !== undefined && compiledMtime <= sourceMtime) return false;
  const launcherMtime = launcherStat?.mtime?.getTime();
  if (launcherMtime !== undefined && compiledMtime <= launcherMtime) {
    return false;
  }
  return true;
}

async function dryRun(
  env: Record<string, string>,
  args: string[] = [],
): Promise<{ route: string; sock: string; autostart: string }> {
  // parse-check spawns a deno child that derives its cache dir from HOME;
  // with the fake HOME these tests set, pin DENO_DIR to the real cache so
  // validity — not cache writability — is what the child reports.
  const realHome = Deno.env.get("HOME") ?? "";
  const denoDir = Deno.env.get("DENO_DIR") ??
    `${realHome}/Library/Caches/deno`;
  const proc = new Deno.Command("bash", {
    args: [LAUNCHER, ...args],
    env: {
      ...Deno.env.toObject(),
      DYFJ_LAUNCHER_DRY_RUN: "1",
      DENO_DIR: denoDir,
      ...env,
    },
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await proc.output();
  const text = new TextDecoder().decode(stdout).trim();
  const err = new TextDecoder().decode(stderr).trim();
  if (code !== 0) {
    throw new Error(`launcher dry-run failed (${code}): ${err || text}`);
  }
  const route = text.match(/^route=(\w+)/)?.[1];
  const sock = text.match(/sock=(.+)$/)?.[1];
  const autostart = text.match(/autostart=(\w+)/)?.[1];
  if (!route || !sock || !autostart) {
    throw new Error(`unexpected dry-run output: ${text}`);
  }
  return { route, sock, autostart };
}

describe("dyfj launcher routing", () => {
  test("resolves its prototype root through a symlink chain", async () => {
    await Deno.mkdir(".vitest-tmp", { recursive: true });
    const root = await Deno.realPath(
      await Deno.makeTempDir({ dir: ".vitest-tmp" }),
    );

    try {
      const bin = `${root}/bin`;
      const target = `${root}/launcher`;
      const link = `${bin}/dyfj`;
      await Deno.mkdir(bin);
      // Use the existing bash grant so fixture setup does not broaden the
      // test profile's filesystem permissions.
      const setup = new Deno.Command("bash", {
        args: [
          "-c",
          'set -e\nln -s "$1" "$2"\nln -s "$3" "$4"',
          "dyfj-test",
          LAUNCHER,
          target,
          "../launcher",
          link,
        ],
        stdout: "null",
        stderr: "piped",
      });
      const setupResult = await setup.output();
      if (setupResult.code !== 0) {
        const err = new TextDecoder().decode(setupResult.stderr).trim();
        throw new Error(`symlink setup failed (${setupResult.code}): ${err}`);
      }

      const proc = new Deno.Command("bash", {
        args: [
          link,
          "--parse-check",
          "--socket",
          `${root}/workbench.sock`,
          "models",
        ],
        env: { ...Deno.env.toObject(), DYFJ_AUTOSTART: "0" },
        stdout: "piped",
        stderr: "piped",
      });
      const { code, stderr } = await proc.output();
      const err = new TextDecoder().decode(stderr).trim();
      if (code !== 0) {
        throw new Error(`symlinked launcher failed (${code}): ${err}`);
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  test("autostart respawns the resolved launcher source", async () => {
    const lines = (await Deno.readTextFile(LAUNCHER)).split("\n");
    const spawns = lines.filter((line) => line.includes("nohup bash "));
    expect(spawns).toHaveLength(1);
    const [spawn] = spawns;
    expect(spawn.trimStart().startsWith("nohup bash ")).toBe(true);
    expect(spawn).toContain("start --launcher-autostarted");
    expect(spawn).toContain('"$LAUNCHER_SOURCE"');
    expect(spawn).not.toContain("BASH_SOURCE");
  });

  test("default path prefers compiled when the binary exists", async () => {
    const { route, sock } = await dryRun({ HOME: "/home/c" });
    expect(sock).toBe("/home/c/.dyfj/run/workbench.sock");
    if (await hasFreshCompiledBin()) {
      expect(route).toBe("compiled");
    } else {
      expect(route).toBe("deno");
    }
  });

  test("DYFJ_SOCKET selects deno when the path is non-default", async () => {
    const { route, sock } = await dryRun({
      HOME: "/home/c",
      DYFJ_SOCKET: "/run/custom.sock",
    });
    expect(sock).toBe("/run/custom.sock");
    expect(route).toBe("deno");
  });

  test("XDG_RUNTIME_DIR selects deno when the path is non-default", async () => {
    const { route, sock } = await dryRun({
      HOME: "/home/c",
      XDG_RUNTIME_DIR: "/run/u",
    });
    expect(sock).toBe("/run/u/dyfj/workbench.sock");
    expect(route).toBe("deno");
  });

  test("explicit DYFJ_SOCKET matching the default still uses compiled when present", async () => {
    const { route, sock } = await dryRun({
      HOME: "/home/c",
      DYFJ_SOCKET: "/home/c/.dyfj/run/workbench.sock",
    });
    expect(sock).toBe("/home/c/.dyfj/run/workbench.sock");
    if (await hasFreshCompiledBin()) {
      expect(route).toBe("compiled");
    } else {
      expect(route).toBe("deno");
    }
  });

  test("HTTP transport does not force deno when a fresh compiled binary is present", async () => {
    if (!(await hasFreshCompiledBin())) return;

    const customOnly = await dryRun({
      HOME: "/home/c",
      DYFJ_SOCKET: "/run/custom.sock",
    });
    const customWithHttp = await dryRun(
      {
        HOME: "/home/c",
        DYFJ_SOCKET: "/run/custom.sock",
        DYFJ_SERVER_URL: "http://127.0.0.1:8787",
      },
    );
    expect(customOnly.route).toBe("deno");
    expect(customWithHttp.route).toBe("compiled");
  });

  test("--unix forces deno fallback despite DYFJ_SERVER_URL with a custom socket", async () => {
    const { route, sock } = await dryRun(
      {
        HOME: "/home/c",
        DYFJ_SOCKET: "/run/custom.sock",
        DYFJ_SERVER_URL: "http://127.0.0.1:8787",
      },
      ["--unix", "models"],
    );
    expect(sock).toBe("/run/custom.sock");
    expect(route).toBe("deno");
  });

  test("committed launcher carries no literal host path", async () => {
    const text = await Deno.readTextFile(LAUNCHER);
    expect(text).not.toMatch(/\/Users\//);
    expect(text).not.toMatch(/\/home\/[a-z]/);
  });
});

describe("dyfj launcher autostart classification", () => {
  // The classification is what the dry-run seam can pin: WHEN the launcher
  // would ensure a runtime. The ensure path itself (probe, detached start,
  // readiness wait) exercises real process lifecycle and is validated in UAT.
  test("a bare invocation (REPL) autostarts", async () => {
    const { autostart } = await dryRun({ HOME: "/home/c" });
    expect(autostart).toBe("yes");
  });
  test("an exec prompt autostarts", async () => {
    const { autostart } = await dryRun({ HOME: "/home/c" }, [
      "exec",
      "hello there",
    ]);
    expect(autostart).toBe("yes");
  });
  test("a prompt merely containing the word start still autostarts", async () => {
    const { autostart } = await dryRun({ HOME: "/home/c" }, [
      "exec",
      "how do I start the runtime",
    ]);
    expect(autostart).toBe("yes");
  });
  test("a bare positional prompt is an unknown command and declines", async () => {
    // `dyfj "hello"` is not a valid invocation — the client requires `exec`
    // or -p — so the parse-check contract correctly refuses to spawn for it.
    const { autostart } = await dryRun({ HOME: "/home/c" }, ["hello there"]);
    expect(autostart).toBe("no");
  });
  test("`start` never autostarts (it IS the start)", async () => {
    const { autostart } = await dryRun({ HOME: "/home/c" }, ["start"]);
    expect(autostart).toBe("no");
  });
  test("`status` stays an honest reporter", async () => {
    const { autostart } = await dryRun({ HOME: "/home/c" }, ["status"]);
    expect(autostart).toBe("no");
  });
  test("help never needs a runtime", async () => {
    const { autostart } = await dryRun({ HOME: "/home/c" }, ["--help"]);
    expect(autostart).toBe("no");
  });
  test("an HTTP session is out of scope", async () => {
    const { autostart } = await dryRun({ HOME: "/home/c" }, [
      "--server",
      "http://127.0.0.1:18080",
    ]);
    expect(autostart).toBe("no");
  });
  test("--no-autostart opts out per call", async () => {
    const { autostart } = await dryRun({ HOME: "/home/c" }, ["--no-autostart"]);
    expect(autostart).toBe("no");
  });
  test("DYFJ_AUTOSTART=0 opts out standing", async () => {
    const { autostart } = await dryRun({
      HOME: "/home/c",
      DYFJ_AUTOSTART: "0",
    });
    expect(autostart).toBe("no");
  });
  test("a custom socket still autostarts (on that socket)", async () => {
    const { autostart, route } = await dryRun({
      HOME: "/home/c",
      DYFJ_SOCKET: "/run/custom.sock",
    });
    expect(autostart).toBe("yes");
    expect(route).toBe("deno");
  });
});

describe("autostart classification is position-aware and socket-coherent", () => {
  test("an explicit --socket drives the launcher's own resolution", async () => {
    const { sock, route, autostart } = await dryRun({ HOME: "/home/c" }, [
      "--socket",
      "/run/explicit.sock",
    ]);
    expect(sock).toBe("/run/explicit.sock");
    expect(route).toBe("deno");
    expect(autostart).toBe("yes");
  });
  test("--socket beats DYFJ_SOCKET", async () => {
    const { sock } = await dryRun(
      { HOME: "/home/c", DYFJ_SOCKET: "/run/env.sock" },
      ["--socket", "/run/flag.sock"],
    );
    expect(sock).toBe("/run/flag.sock");
  });
  test("a -p prompt that is literally the word start still autostarts", async () => {
    const { autostart } = await dryRun({ HOME: "/home/c" }, ["-p", "start"]);
    expect(autostart).toBe("yes");
  });
  test("a --model value named status is a value, not a subcommand", async () => {
    // --model takes an arbitrary slug, so this pins value-position handling
    // without tripping the client's session-ref validation (a --session value
    // of "status" is genuinely invalid there, and correctly declines).
    const { autostart } = await dryRun({ HOME: "/home/c" }, [
      "--model",
      "status",
    ]);
    expect(autostart).toBe("yes");
  });
});

describe("prompt values cannot become launcher control input", () => {
  // Adversarial argument shapes: an argument in a value slot that LOOKS like
  // a launcher flag must be data, never control.
  test("a -p prompt of --socket does not capture the next arg as a socket", async () => {
    const { sock, autostart } = await dryRun({ HOME: "/home/c" }, [
      "-p",
      "--socket",
      "--model",
      "foo",
    ]);
    expect(sock).toBe("/home/c/.dyfj/run/workbench.sock");
    expect(autostart).toBe("yes");
  });
  test("a -p prompt of --no-autostart does not opt out", async () => {
    const { autostart } = await dryRun({ HOME: "/home/c" }, [
      "-p",
      "--no-autostart",
      "--model",
      "foo",
    ]);
    expect(autostart).toBe("yes");
  });
  test("a -p prompt of --help does not suppress autostart", async () => {
    const { autostart } = await dryRun({ HOME: "/home/c" }, ["-p", "--help"]);
    expect(autostart).toBe("yes");
  });
  test("a -p prompt of -h does not suppress autostart", async () => {
    const { autostart } = await dryRun({ HOME: "/home/c" }, ["-p", "-h"]);
    expect(autostart).toBe("yes");
  });
  test("a control-position --help still opts out", async () => {
    const { autostart } = await dryRun({ HOME: "/home/c" }, ["--help"]);
    expect(autostart).toBe("no");
  });
  test("a -p prompt of --server does not switch transport", async () => {
    const { autostart } = await dryRun({ HOME: "/home/c" }, [
      "-p",
      "--server",
      "--model",
      "foo",
    ]);
    expect(autostart).toBe("yes");
  });
});

describe("autostart requires an absolute private log home", () => {
  async function runReal(
    env: Record<string, string>,
    cwd: string,
  ): Promise<{ code: number; err: string }> {
    const proc = new Deno.Command("bash", {
      args: [LAUNCHER, "sessions"],
      cwd,
      env: { ...Deno.env.toObject(), ...env, DYFJ_LAUNCHER_DRY_RUN: "" },
      stdout: "null",
      stderr: "piped",
    });
    const { code, stderr } = await proc.output();
    return { code, err: new TextDecoder().decode(stderr) };
  }

  test("empty HOME declines instead of logging into the cwd", async () => {
    await Deno.mkdir(".vitest-tmp", { recursive: true });
    const cwd = await Deno.makeTempDir({ dir: ".vitest-tmp" });
    // A socket that certainly is not answering, so the ensure path runs.
    const { code, err } = await runReal(
      { HOME: "", DYFJ_SOCKET: `${cwd}/x.sock` },
      cwd,
    );
    expect(code).not.toBe(0);
    expect(err).toContain("absolute HOME");
    // Nothing durable appears in the invoking directory.
    const entries: string[] = [];
    for await (const e of Deno.readDir(cwd)) entries.push(e.name);
    expect(entries).not.toContain(".dyfj");
    await Deno.remove(cwd, { recursive: true });
  }, 30_000);

  test("relative HOME declines the same way", async () => {
    await Deno.mkdir(".vitest-tmp", { recursive: true });
    const cwd = await Deno.makeTempDir({ dir: ".vitest-tmp" });
    const { code, err } = await runReal(
      { HOME: "relative/home", DYFJ_SOCKET: `${cwd}/x.sock` },
      cwd,
    );
    expect(code).not.toBe(0);
    expect(err).toContain("absolute HOME");
    await Deno.remove(cwd, { recursive: true });
  }, 30_000);
});

describe("an invocation the client's parser rejects never triggers autostart", () => {
  test("an unknown flag declines autostart", async () => {
    const { autostart } = await dryRun({ HOME: "/home/c" }, ["--bogus"]);
    expect(autostart).toBe("no");
  });
  test("an invalid enum value declines autostart", async () => {
    const { autostart } = await dryRun({ HOME: "/home/c" }, ["--tier", "3"]);
    expect(autostart).toBe("no");
  });
  test("an explicitly empty --socket declines autostart", async () => {
    const { autostart } = await dryRun({ HOME: "/home/c" }, ["--socket", ""]);
    expect(autostart).toBe("no");
  });
  test("a value flag with no value declines autostart", async () => {
    const { autostart } = await dryRun({ HOME: "/home/c" }, ["--socket"]);
    expect(autostart).toBe("no");
  });
  test("a bare -p declines autostart", async () => {
    const { autostart } = await dryRun({ HOME: "/home/c" }, ["-p"]);
    expect(autostart).toBe("no");
  });
});

describe("a -p prompt makes the invocation a turn the runtime is needed for", () => {
  test("status alongside -p does not suppress the runtime the turn needs", async () => {
    // The client resolves a prompt before subcommands, so this is a turn, not
    // the `status` report — suppressing autostart leaves it failing against
    // nothing.
    const { autostart } = await dryRun({ HOME: "/home/c" }, [
      "-p",
      "status of the build",
      "status",
    ]);
    expect(autostart).toBe("yes");
  });

  test("a help FLAG wins over a prompt", async () => {
    const { autostart } = await dryRun({ HOME: "/home/c" }, [
      "--help",
      "-p",
      "hello",
    ]);
    expect(autostart).toBe("no");
  });

  test("a positional help alongside a prompt is a turn, matching the client", async () => {
    // parseArgs gives help precedence to the -h/--help FLAG state only: a
    // populated -p returns an exec command before positional-command
    // validation, so this invocation is a print turn and needs a runtime.
    const { autostart } = await dryRun({ HOME: "/home/c" }, [
      "help",
      "-p",
      "hello",
    ]);
    expect(autostart).toBe("yes");
  });
});

describe("the probe invokes the client on the UDS seam explicitly", () => {
  test("both client routes pass --unix before status", async () => {
    const lines = (await Deno.readTextFile(LAUNCHER)).split("\n");
    const open = lines.findIndex((l) => l.trim() === "probe_runtime() {");
    expect(open).toBeGreaterThanOrEqual(0);
    const close = lines.findIndex((l, i) => i > open && l === "}");
    expect(close).toBeGreaterThan(open);
    const body = lines.slice(open, close);
    const invocations = body.filter((l) =>
      l.trimEnd().endsWith("status >/dev/null 2>&1")
    );
    // One per route — compiled and deno. A third would be an unreviewed call.
    expect(invocations).toHaveLength(2);
    for (const line of invocations) {
      expect(line).toContain("--unix");
      expect(line.indexOf("--unix")).toBeLessThan(line.indexOf(" status "));
    }
  });
});
