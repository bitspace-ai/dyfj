import { describe, expect, test } from "vitest";
import { reapPidsAndCommandsContaining } from "./test-process-harness.ts";

const LAUNCHER = new URL("./dyfj-launcher.sh", import.meta.url).pathname;
const COMPILED_BIN = new URL("../dist/dyfj-bin", import.meta.url).pathname;
const BASH = Deno.build.os === "darwin" ? "/bin/bash" : "bash";

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
): Promise<{
  route: string;
  sock: string;
  autostart: string;
  nodePath: string;
  toolchainDirectories: string;
}> {
  // parse-check spawns a deno child that derives its cache dir from HOME;
  // with the fake HOME these tests set, pin DENO_DIR to the real cache so
  // validity — not cache writability — is what the child reports.
  const realHome = Deno.env.get("HOME") ?? "";
  const denoDir = Deno.env.get("DENO_DIR") ??
    `${realHome}/Library/Caches/deno`;
  const proc = new Deno.Command(BASH, {
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
  const sock = text.match(/sock=(.*?) toolchain_directories=/)?.[1];
  const autostart = text.match(/autostart=(\w+)/)?.[1];
  const nodePath = text.match(/node_path=(.*?) sock=/)?.[1];
  const toolchainDirectories = text.match(/toolchain_directories=(\d+)/)?.[1];
  if (
    !route || !sock || !autostart || nodePath === undefined ||
    toolchainDirectories === undefined
  ) {
    throw new Error(`unexpected dry-run output: ${text}`);
  }
  return { route, sock, autostart, nodePath, toolchainDirectories };
}

describe("dyfj launcher routing", () => {
  test("accepts an operator-authorized executable and ignores stale optional paths", async () => {
    const node = await new Deno.Command("bash", {
      args: ["-c", "node -p process.execPath"],
      stdout: "piped",
    }).output();
    expect(node.success).toBe(true);
    const nodePath = new TextDecoder().decode(node.stdout).trim();
    await expect(dryRun({
      HOME: "/home/c",
      DYFJ_NODE_PATH: nodePath,
    })).resolves.toMatchObject({ autostart: "yes", nodePath });
    await expect(dryRun({
      HOME: "/home/c",
      DYFJ_NODE_PATH: "node",
    }, ["-p", "inspect"])).resolves.toMatchObject({
      autostart: "yes",
      nodePath: "",
    });
    await expect(dryRun({
      HOME: "/home/c",
      DYFJ_NODE_PATH: nodePath,
    }, ["--runner", "fixture", "-p", "inspect"])).resolves.toMatchObject({
      autostart: "yes",
      nodePath,
    });
  });

  test("accepts an executable selected from the operator's PATH", async () => {
    await Deno.mkdir(".vitest-tmp", { recursive: true });
    const root = await Deno.realPath(
      await Deno.makeTempDir({ dir: ".vitest-tmp" }),
    );
    const node = `${root}/node`;
    await Deno.writeTextFile(node, "#!/bin/sh\nexit 1\n");
    await Deno.chmod(node, 0o700);
    try {
      await expect(dryRun({
        HOME: "/home/c",
        DYFJ_NODE_PATH: "",
        PATH: `${root}:${Deno.env.get("PATH") ?? "/usr/bin:/bin"}`,
      })).resolves.toMatchObject({ autostart: "yes", nodePath: node });
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  test("projects only valid explicit toolchain directories as count-only evidence", async () => {
    const directory = await Deno.makeTempDir({ dir: Deno.cwd() });
    const rustupHome = await Deno.makeTempDir({ dir: Deno.cwd() });
    const toolchainLink = `${directory}-link`;
    const rustupLink = `${rustupHome}-link`;
    const linked = await new Deno.Command("bash", {
      args: [
        "-c",
        '/bin/ln -s "$1" "$2" && /bin/ln -s "$3" "$4"',
        "bash",
        directory,
        toolchainLink,
        rustupHome,
        rustupLink,
      ],
    }).output();
    expect(linked.success).toBe(true);
    try {
      await expect(dryRun({
        HOME: "/home/c",
        DYFJ_CODEX_TOOLCHAIN_PATH: directory,
        DYFJ_CODEX_RUSTUP_HOME: rustupHome,
      }, ["--socket", "/tmp/dyfj-toolchain-test.sock", "-p", "inspect"]))
        .resolves.toMatchObject({
          toolchainDirectories: "2",
        });
      await expect(dryRun({
        HOME: "/home/c",
        DYFJ_CODEX_TOOLCHAIN_PATH: directory,
        DYFJ_CODEX_RUSTUP_HOME: directory,
      }, ["--socket", "/tmp/dyfj-toolchain-test.sock", "-p", "inspect"]))
        .resolves.toMatchObject({
          toolchainDirectories: "1",
        });
      for (
        const value of ["relative", `${directory},extra`, `${directory}:extra`]
      ) {
        await expect(dryRun({
          HOME: "/home/c",
          DYFJ_CODEX_TOOLCHAIN_PATH: value,
        }, ["--socket", "/tmp/dyfj-toolchain-test.sock", "-p", "inspect"]))
          .rejects.toThrow(
            "absolute, delimiter-safe directory",
          );
      }
      for (
        const value of [
          "relative",
          `${rustupHome},extra`,
          `${rustupHome}:extra`,
        ]
      ) {
        await expect(dryRun({
          HOME: "/home/c",
          DYFJ_CODEX_RUSTUP_HOME: value,
        }, ["--socket", "/tmp/dyfj-toolchain-test.sock", "-p", "inspect"]))
          .rejects.toThrow("absolute, delimiter-safe directory");
      }
      for (const value of [toolchainLink, `${toolchainLink}/`]) {
        await expect(dryRun({
          HOME: "/home/c",
          DYFJ_CODEX_TOOLCHAIN_PATH: value,
        }, ["--socket", "/tmp/dyfj-toolchain-test.sock", "-p", "inspect"]))
          .rejects.toThrow("toolchain directory is unavailable");
      }
      for (const value of ["/", "///"]) {
        await expect(dryRun({
          HOME: "/home/c",
          DYFJ_CODEX_TOOLCHAIN_PATH: value,
        }, ["--socket", "/tmp/dyfj-toolchain-test.sock", "-p", "inspect"]))
          .rejects.toThrow("toolchain directory is unavailable");
      }
      for (const value of [rustupLink, `${rustupLink}/`]) {
        await expect(dryRun({
          HOME: "/home/c",
          DYFJ_CODEX_RUSTUP_HOME: value,
        }, ["--socket", "/tmp/dyfj-toolchain-test.sock", "-p", "inspect"]))
          .rejects.toThrow("Rustup home directory is unavailable");
      }
      for (const value of ["/", "///"]) {
        await expect(dryRun({
          HOME: "/home/c",
          DYFJ_CODEX_RUSTUP_HOME: value,
        }, ["--socket", "/tmp/dyfj-toolchain-test.sock", "-p", "inspect"]))
          .rejects.toThrow("Rustup home directory is unavailable");
      }
    } finally {
      await Deno.remove(toolchainLink);
      await Deno.remove(rustupLink);
      await Deno.remove(directory);
      await Deno.remove(rustupHome);
    }
  });

  test("rejects whole dot components before resolving toolchain directories", async () => {
    const root = await Deno.makeTempDir({ dir: Deno.cwd() });
    const child = `${root}/child`;
    const alias = `${root}/alias`;
    const dotted = [
      `${root}/.cargo`,
      `${root}/.rustup`,
      `${root}/..cache`,
      `${root}/tool.chain`,
    ];
    await Deno.mkdir(child);
    for (const directory of dotted) await Deno.mkdir(directory);
    const linked = await new Deno.Command("bash", {
      args: ["-c", '/bin/ln -s "$1" "$2"', "bash", child, alias],
    }).output();
    expect(linked.success).toBe(true);
    try {
      for (
        const [envName, diagnostic] of [
          [
            "DYFJ_CODEX_TOOLCHAIN_PATH",
            "dyfj: Codex toolchain path must not contain dot components",
          ],
          [
            "DYFJ_CODEX_RUSTUP_HOME",
            "dyfj: Codex Rustup home must not contain dot components",
          ],
        ] as const
      ) {
        for (
          const value of [
            `${root}/./child`,
            `${root}/../${root.split("/").at(-1)}/child`,
            `${child}/.`,
            `${child}/..`,
            `${child}/./`,
            `${child}/../`,
            "/.",
            "/..",
            `${root}//.//child/`,
            `${root}//..//${root.split("/").at(-1)}//child/`,
            `${alias}/../child`,
          ]
        ) {
          let failure: Error | undefined;
          try {
            await dryRun({ HOME: "/home/c", [envName]: value }, [
              "--socket",
              "/tmp/dyfj-toolchain-test.sock",
              "-p",
              "inspect",
            ]);
          } catch (error) {
            failure = error instanceof Error ? error : new Error(String(error));
          }
          expect(failure?.message).toContain(diagnostic);
          expect(failure?.message).not.toContain(value);
        }
        for (const directory of dotted) {
          await expect(dryRun({ HOME: "/home/c", [envName]: directory }, [
            "--socket",
            "/tmp/dyfj-toolchain-test.sock",
            "-p",
            "inspect",
          ])).resolves.toMatchObject({ toolchainDirectories: "1" });
        }
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }, 15_000);

  test("rejects delimiter-bearing canonical toolchain paths without disclosing them", async () => {
    await Deno.mkdir(".vitest-tmp", { recursive: true });
    const root = await Deno.realPath(
      await Deno.makeTempDir({ dir: ".vitest-tmp" }),
    );
    const unsafeParent = `${root}/private,parent`;
    const unsafeDirectory = `${unsafeParent}/bin`;
    const safeAlias = `${root}/selected`;
    await Deno.mkdir(unsafeDirectory, { recursive: true });
    const linked = await new Deno.Command("bash", {
      args: ["-c", '/bin/ln -s "$1" "$2"', "bash", unsafeParent, safeAlias],
    }).output();
    expect(linked.success).toBe(true);
    const selected = `${safeAlias}/bin`;
    try {
      for (
        const [envName, diagnostic] of [
          [
            "DYFJ_CODEX_TOOLCHAIN_PATH",
            "Codex toolchain directory is unavailable",
          ],
          [
            "DYFJ_CODEX_RUSTUP_HOME",
            "Codex Rustup home directory is unavailable",
          ],
        ] as const
      ) {
        let failure: Error | undefined;
        try {
          await dryRun({
            HOME: "/home/c",
            [envName]: selected,
          }, ["--socket", "/tmp/dyfj-toolchain-test.sock", "-p", "inspect"]);
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
        }
        expect(failure?.message).toContain(diagnostic);
        expect(failure?.message).not.toContain(unsafeParent);
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  test("counts canonical directories whose names differ only by trailing newlines", async () => {
    await Deno.mkdir(".vitest-tmp", { recursive: true });
    const root = await Deno.realPath(
      await Deno.makeTempDir({ dir: ".vitest-tmp" }),
    );
    const toolchain = `${root}/toolchain`;
    const rustupHome = `${toolchain}\n`;
    await Deno.mkdir(toolchain);
    await Deno.mkdir(rustupHome);
    try {
      await expect(dryRun({
        HOME: "/home/c",
        DYFJ_CODEX_TOOLCHAIN_PATH: toolchain,
        DYFJ_CODEX_RUSTUP_HOME: rustupHome,
      }, ["--socket", "/tmp/dyfj-toolchain-test.sock", "-p", "inspect"]))
        .resolves.toMatchObject({ toolchainDirectories: "2" });
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  test("rejects an executable directory as Node authority", async () => {
    await Deno.mkdir(".vitest-tmp", { recursive: true });
    const directory = await Deno.realPath(
      await Deno.makeTempDir({ dir: ".vitest-tmp" }),
    );
    try {
      await expect(dryRun({
        HOME: "/home/c",
        DYFJ_NODE_PATH: directory,
      }, ["-p", "inspect"])).resolves.toMatchObject({
        autostart: "yes",
        nodePath: "",
      });
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  test("rejects delimiter-unsafe executable paths", async () => {
    await Deno.mkdir(".vitest-tmp", { recursive: true });
    const root = await Deno.realPath(
      await Deno.makeTempDir({ dir: ".vitest-tmp" }),
    );
    try {
      for (const delimiter of [",", ":"]) {
        const node = `${root}/node${delimiter}unsafe`;
        await Deno.writeTextFile(node, "#!/bin/sh\nexit 0\n");
        await Deno.chmod(node, 0o700);
        await expect(dryRun({
          HOME: "/home/c",
          DYFJ_NODE_PATH: node,
        }, ["-p", "inspect"])).resolves.toMatchObject({
          autostart: "yes",
          nodePath: "",
        });
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  test("does not inspect an optional executable path for status", async () => {
    await Deno.mkdir(".vitest-tmp", { recursive: true });
    const root = await Deno.makeTempDir({ dir: ".vitest-tmp" });
    const marker = `${root}/invoked`;
    const node = `${root}/node`;
    await Deno.writeTextFile(node, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    await Deno.chmod(node, 0o700);
    try {
      await expect(dryRun({
        HOME: "/home/c",
        DYFJ_NODE_PATH: node,
      }, ["status"])).resolves.toMatchObject({ autostart: "no" });
      await expect(Deno.stat(marker)).rejects.toBeInstanceOf(
        Deno.errors.NotFound,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  test("does not execute the operator-selected path during discovery", async () => {
    await Deno.mkdir(".vitest-tmp", { recursive: true });
    const root = await Deno.makeTempDir({ dir: ".vitest-tmp" });
    const marker = `${root}/invoked`;
    const node = `${root}/node`;
    await Deno.writeTextFile(
      node,
      `#!/bin/sh\ntouch '${marker}'\nexec sleep 30\n`,
    );
    await Deno.chmod(node, 0o700);
    try {
      const startedAt = Date.now();
      await expect(dryRun({
        HOME: "/home/c",
        DYFJ_NODE_PATH: node,
      }, ["-p", "inspect"])).resolves.toMatchObject({ autostart: "yes" });
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      await expect(Deno.stat(marker)).rejects.toBeInstanceOf(
        Deno.errors.NotFound,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

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

      const proc = new Deno.Command(BASH, {
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


  test("committed launcher carries no literal host path", async () => {
    const text = await Deno.readTextFile(LAUNCHER);
    expect(text).not.toMatch(/\/Users\//);
    expect(text).not.toMatch(/\/home\/[a-z]/);
  });

  test("a socket path containing spaces remains intact in dry-run evidence", async () => {
    const sock = "/tmp/dyfj workbench.sock";
    await expect(dryRun({
      HOME: "/home/c",
      DYFJ_SOCKET: sock,
    }, ["--no-autostart", "status"])).resolves.toMatchObject({ sock });
  });

  test("dry-run validates optional paths when autostart is disabled", async () => {
    await expect(dryRun({
      HOME: "/home/c",
      DYFJ_CODEX_TOOLCHAIN_PATH: "relative-toolchain",
    }, ["--no-autostart", "status"])).rejects.toThrow(
      "absolute, delimiter-safe directory",
    );
    await expect(dryRun({
      HOME: "/home/c",
      DYFJ_CODEX_RUSTUP_HOME: "relative-rustup-home",
    }, ["--no-autostart", "status"])).rejects.toThrow(
      "absolute, delimiter-safe directory",
    );
  });

  test("a successful runtime probe bypasses stale optional start authority", async () => {
    await Deno.mkdir(".vitest-tmp", { recursive: true });
    const root = await Deno.realPath(
      await Deno.makeTempDir({ dir: ".vitest-tmp" }),
    );
    const bin = `${root}/bin`;
    const deno = `${bin}/deno`;
    await Deno.mkdir(bin);
    await Deno.writeTextFile(deno, "#!/bin/sh\nexit 0\n");
    await Deno.chmod(deno, 0o700);
    try {
      const proc = new Deno.Command(BASH, {
        args: [
          LAUNCHER,
          "--socket",
          `${root}/workbench.sock`,
          "sessions",
        ],
        env: {
          ...Deno.env.toObject(),
          PATH: `${bin}:/usr/bin:/bin`,
          DYFJ_CODEX_TOOLCHAIN_PATH: `${root}/missing-toolchain`,
          DYFJ_CODEX_RUSTUP_HOME: `${root}/missing-rustup-home`,
          DYFJ_LAUNCHER_DRY_RUN: "",
        },
        stdout: "piped",
        stderr: "piped",
      });
      const { code, stderr } = await proc.output();
      expect(code).toBe(0);
      expect(new TextDecoder().decode(stderr)).not.toContain("unavailable");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
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
  test("`stop` never triggers autostart", async () => {
    const { autostart } = await dryRun({ HOME: "/home/c" }, ["stop"]);
    expect(autostart).toBe("no");
  });
  test("help never needs a runtime", async () => {
    const { autostart } = await dryRun({ HOME: "/home/c" }, ["--help"]);
    expect(autostart).toBe("no");
  });
  test("retired HTTP transport flags decline autostart as unknown", async () => {
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
  test("a -p prompt of --server does not decline autostart", async () => {
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
    const proc = new Deno.Command(BASH, {
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

describe("the probe invokes the client on the UDS seam", () => {
  test("both client routes invoke status without a retired transport flag", async () => {
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
      expect(line).toContain(" status ");
      expect(line).not.toContain("--unix");
      expect(line).not.toContain("--server");
    }
  });
});

async function readUntilStderr(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  target: string,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.includes(target)) break;
  }
  return text;
}

async function safeRemove(dir: string) {
  for (let i = 0; i < 10; i++) {
    try {
      await Deno.remove(dir, { recursive: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

describe("start lock rate-limits repeated background autostart attempts", () => {
  test("an active in-flight start lock prevents spawning a second start process", async () => {
    await Deno.mkdir(".vitest-tmp", { recursive: true });
    const home = await Deno.realPath(
      await Deno.makeTempDir({ dir: ".vitest-tmp" }),
    );
    const sock = `${home}/test-runtime.sock`;
    const base = "test-runtime";
    const hashProc = new Deno.Command(BASH, {
      args: ["-c", 'h=$(printf "%s" "$1" | shasum -a 256 2>/dev/null | cut -c1-16); [[ -n "$h" ]] && echo "$h" || printf "%s" "$1" | cksum | cut -d" " -f1', "bash", sock],
      stdout: "piped",
    });
    const hashOutput = await hashProc.output();
    const hash = new TextDecoder().decode(hashOutput.stdout).trim();

    const runDir = `${home}/.dyfj/run`;
    await Deno.mkdir(runDir, { recursive: true });
    const lockFile = `${runDir}/start-${base}-${hash}.lock`;

    const nowSec = Math.floor(Date.now() / 1000);
    await Deno.writeTextFile(lockFile, `${nowSec}\n`);

    const proc = new Deno.Command(BASH, {
      args: [LAUNCHER, "--socket", sock, "sessions"],
      env: {
        ...Deno.env.toObject(),
        HOME: home,
        DYFJ_SOCKET: sock,
        DYFJ_START_LOCK_TTL_SEC: "30",
        DYFJ_LAUNCHER_DRY_RUN: "",
      },
      stdout: "null",
      stderr: "piped",
    }).spawn();

    try {
      const reader = proc.stderr.getReader();
      const errText = await readUntilStderr(reader, "already in flight");
      expect(errText).toContain("already in flight");
      expect(errText).not.toContain("runtime not running at");
      const lockContent = await Deno.readTextFile(lockFile);
      expect(lockContent.trim()).toBe(`${nowSec}`);
    } finally {
      try {
        proc.kill("SIGTERM");
        await proc.status;
      } catch {
        // ignore
      }
      await reapPidsAndCommandsContaining([proc.pid], sock);
      await safeRemove(home);
    }
  }, 10_000);

  test("a stale in-flight start lock (> TTL) is overwritten and allows a fresh start", async () => {
    await Deno.mkdir(".vitest-tmp", { recursive: true });
    const home = await Deno.realPath(
      await Deno.makeTempDir({ dir: ".vitest-tmp" }),
    );
    const sock = `${home}/test-runtime.sock`;
    const base = "test-runtime";
    const hashProc = new Deno.Command(BASH, {
      args: ["-c", 'h=$(printf "%s" "$1" | shasum -a 256 2>/dev/null | cut -c1-16); [[ -n "$h" ]] && echo "$h" || printf "%s" "$1" | cksum | cut -d" " -f1', "bash", sock],
      stdout: "piped",
    });
    const hashOutput = await hashProc.output();
    const hash = new TextDecoder().decode(hashOutput.stdout).trim();

    const runDir = `${home}/.dyfj/run`;
    await Deno.mkdir(runDir, { recursive: true });
    const lockFile = `${runDir}/start-${base}-${hash}.lock`;

    // Stale timestamp (100 seconds ago) with no alive PID
    const staleSec = Math.floor(Date.now() / 1000) - 100;
    await Deno.writeTextFile(lockFile, `${staleSec}\n`);

    const beforeSec = Math.floor(Date.now() / 1000) - 2;
    let spawnedPid: number | undefined;
    let updatedTs: number | undefined;

    const proc = new Deno.Command(BASH, {
      args: [LAUNCHER, "--socket", sock, "sessions"],
      env: {
        ...Deno.env.toObject(),
        HOME: home,
        DYFJ_SOCKET: sock,
        DYFJ_START_LOCK_TTL_SEC: "30",
        DYFJ_LAUNCHER_DRY_RUN: "",
      },
      stdout: "null",
      stderr: "piped",
    }).spawn();

    try {
      const reader = proc.stderr.getReader();
      const errText = await readUntilStderr(reader, "runtime not running at");
      expect(errText).toContain("runtime not running at");
      expect(errText).not.toContain("already in flight");
      try {
        const lockContent = await Deno.readTextFile(lockFile);
        const parts = lockContent.trim().split(/\s+/);
        if (parts.length >= 1) {
          updatedTs = parseInt(parts[0], 10);
        }
        if (parts.length >= 2) {
          spawnedPid = parseInt(parts[1], 10);
        }
      } catch {
        // ignore if lock file was unlinked
      }
      if (updatedTs !== undefined) {
        expect(updatedTs).toBeGreaterThanOrEqual(beforeSec);
      }
      if (spawnedPid !== undefined) {
        expect(spawnedPid).toBeGreaterThan(0);
      }
    } finally {
      try {
        proc.kill("SIGTERM");
        await proc.status;
      } catch {
        // ignore
      }
      await reapPidsAndCommandsContaining(
        [proc.pid, spawnedPid ?? 0],
        sock,
      );
      await safeRemove(home);
    }
  }, 10_000);

  test("an in-flight start lock with an active living process suppresses duplicate spawn", async () => {
    await Deno.mkdir(".vitest-tmp", { recursive: true });
    const home = await Deno.realPath(
      await Deno.makeTempDir({ dir: ".vitest-tmp" }),
    );
    const sock = `${home}/test-runtime.sock`;
    const base = "test-runtime";
    const hashProc = new Deno.Command(BASH, {
      args: ["-c", 'h=$(printf "%s" "$1" | shasum -a 256 2>/dev/null | cut -c1-16); [[ -n "$h" ]] && echo "$h" || printf "%s" "$1" | cksum | cut -d" " -f1', "bash", sock],
      stdout: "piped",
    });
    const hashOutput = await hashProc.output();
    const hash = new TextDecoder().decode(hashOutput.stdout).trim();

    const runDir = `${home}/.dyfj/run`;
    await Deno.mkdir(runDir, { recursive: true });
    const lockFile = `${runDir}/start-${base}-${hash}.lock`;

    // Spawn a dummy background process via BASH to represent a living in-flight start
    const dummy = new Deno.Command(BASH, {
      args: ["-c", "sleep 60"],
    }).spawn();

    const nowSec = Math.floor(Date.now() / 1000);
    await Deno.writeTextFile(lockFile, `${nowSec} ${dummy.pid}\n`);

    const proc = new Deno.Command(BASH, {
      args: [LAUNCHER, "--socket", sock, "sessions"],
      env: {
        ...Deno.env.toObject(),
        HOME: home,
        DYFJ_SOCKET: sock,
        DYFJ_START_LOCK_TTL_SEC: "30",
        DYFJ_LAUNCHER_DRY_RUN: "",
      },
      stdout: "null",
      stderr: "piped",
    }).spawn();

    try {
      const reader = proc.stderr.getReader();
      const errText = await readUntilStderr(reader, "already in flight");
      expect(errText).toContain("already in flight");
      expect(errText).not.toContain("runtime not running at");
    } finally {
      try {
        proc.kill("SIGTERM");
        await proc.status;
      } catch {
        // ignore
      }
      try {
        dummy.kill("SIGTERM");
        await dummy.status;
      } catch {
        // ignore
      }
      await reapPidsAndCommandsContaining([proc.pid, dummy.pid], sock);
      await safeRemove(home);
    }
  }, 10_000);
});



describe("socket-path grant delimiter safety", () => {
  async function launchExpectingRejection(
    env: Record<string, string>,
    args: string[],
  ): Promise<{ code: number; err: string }> {
    const { code, stderr } = await new Deno.Command(BASH, {
      args: [LAUNCHER, ...args],
      env: {
        ...Deno.env.toObject(),
        DYFJ_LAUNCHER_DRY_RUN: "1",
        ...env,
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    return { code, err: new TextDecoder().decode(stderr) };
  }

  test("a comma-bearing DYFJ_SOCKET fails closed before any grant is built", async () => {
    const { code, err } = await launchExpectingRejection(
      { DYFJ_SOCKET: "/tmp/x.sock,example.invalid:443" },
      ["status"],
    );
    expect(code).not.toBe(0);
    expect(err).toContain("must not contain a comma");
    // Content-free: the rejected value (which may carry private path content
    // or control bytes) must not be echoed back.
    expect(err).not.toContain("example.invalid");
  });

  test("the rejection is content-free for control-bearing values", async () => {
    const { code, err } = await launchExpectingRejection(
      { DYFJ_SOCKET: "/tmp/\u001b[2Jevil,x.sock" },
      ["status"],
    );
    expect(code).not.toBe(0);
    expect(err).toContain("must not contain a comma");
    expect(err).not.toContain("evil");
    expect(err).not.toContain("\u001b");
  });

  test("a comma-bearing --socket flag fails closed before any grant is built", async () => {
    const { code, err } = await launchExpectingRejection(
      {},
      ["--socket", "/tmp/x.sock,example.invalid:443", "status"],
    );
    expect(code).not.toBe(0);
    expect(err).toContain("must not contain a comma");
  });

  test("a comma-bearing XDG_RUNTIME_DIR fails closed before any grant is built", async () => {
    const { code, err } = await launchExpectingRejection(
      { XDG_RUNTIME_DIR: "/tmp/x,evil" },
      ["status"],
    );
    expect(code).not.toBe(0);
    expect(err).toContain("must not contain a comma");
  });
});

describe("compile-cli grant construction", () => {
  async function compileWithHome(
    home: string,
  ): Promise<{ code: number; err: string }> {
    const cwd = new URL("..", import.meta.url).pathname;
    const { code, stderr } = await new Deno.Command("deno", {
      args: ["task", "compile-cli"],
      cwd,
      env: { ...Deno.env.toObject(), HOME: home },
      stdout: "piped",
      stderr: "piped",
    }).output();
    return { code, err: new TextDecoder().decode(stderr) };
  }

  test("whitespace in HOME fails closed before any compile", async () => {
    const { code, err } = await compileWithHome("/tmp/has space");
    expect(code).not.toBe(0);
    expect(err).toContain("free of commas and whitespace");
  });

  test("a comma in HOME fails closed before any compile", async () => {
    const { code, err } = await compileWithHome("/tmp/has,comma");
    expect(code).not.toBe(0);
    expect(err).toContain("free of commas and whitespace");
  });

  test("a relative HOME fails closed before any compile", async () => {
    const { code, err } = await compileWithHome("relative/home");
    expect(code).not.toBe(0);
    expect(err).toContain("absolute home path");
  });
});
