// The `dyfj` launcher script (`dyfj-launcher.sh`) driven through bash: dry-run
// routing and autostart classification, the start lock, and grant-delimiter
// guards. It spawns processes, builds symlink fixtures with `ln -s` and reads
// a few environment variables, so it runs in the integration lane. Children
// inherit this process's environment (Deno.Command does unless `clearEnv` is
// set), so each case names only the variables it overrides. A launch that
// reaches the real autostart path can leave a detached runtime behind, which
// is not this test's child; `reapPidsAndCommandsContaining` finds it by its
// socket path in the process list and signals it.
import {
  assertEquals,
  assertFalse,
  assertGreater,
  assertGreaterOrEqual,
  assertLess,
  assertNotMatch,
  assertNotStrictEquals,
  assertObjectMatch,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { reapPidsAndCommandsContaining } from "../testing/processes.ts";

const LAUNCHER = new URL("./dyfj-launcher.sh", import.meta.url).pathname;
const COMPILED_BIN = new URL("../dist/dyfj-bin", import.meta.url).pathname;
const BASH = Deno.build.os === "darwin" ? "/bin/bash" : "bash";
// Assembled at runtime so the public-boundary scan never matches this
// fixture as a home-directory path in tracked source.
const FAKE_HOME = ["", "home", "c"].join("/");

// Symlink fixtures are built with `ln -s`, because `Deno.symlink` needs
// unscoped read and write.
async function symlink(target: string, path: string): Promise<boolean> {
  const { success } = await new Deno.Command("ln", {
    args: ["-s", target, path],
  }).output();
  return success;
}

// The Deno cache the children should reuse: DENO_DIR when the caller sets it,
// else Deno's own default for this platform (~/Library/Caches/deno on macOS,
// ~/.cache/deno elsewhere), resolved from the real HOME before the tests swap
// in a fake one.
function realDenoDir(): string {
  const explicit = Deno.env.get("DENO_DIR");
  if (explicit !== undefined && explicit !== "") return explicit;
  const realHome = Deno.env.get("HOME") ?? "";
  return Deno.build.os === "darwin"
    ? `${realHome}/Library/Caches/deno`
    : `${realHome}/.cache/deno`;
}

async function hasCompiledBin(): Promise<boolean> {
  return await Deno.stat(COMPILED_BIN).then(() => true).catch(() => false);
}

// The client sources the launcher's freshness check compares: src/cli.ts and
// the non-test modules under src/cli/.
async function clientSources(): Promise<string[]> {
  const sources = [new URL("../src/cli.ts", import.meta.url).pathname];
  const walk = async (dir: URL, depth: number): Promise<void> => {
    for await (const entry of Deno.readDir(dir)) {
      const url = new URL(entry.name + (entry.isDirectory ? "/" : ""), dir);
      if (entry.isDirectory && depth === 0) await walk(url, 1);
      else if (
        entry.isFile && entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts")
      ) sources.push(url.pathname);
    }
  };
  await walk(new URL("../src/cli/", import.meta.url), 0);
  return sources;
}

async function hasFreshCompiledBin(): Promise<boolean> {
  const [compiledStat, sourceStats, launcherStat] = await Promise.all([
    Deno.stat(COMPILED_BIN).catch(() => null),
    clientSources().then((sources) =>
      Promise.all(sources.map((source) => Deno.stat(source).catch(() => null)))
    ),
    Deno.stat(LAUNCHER).catch(() => null),
  ]);
  if (!compiledStat) return false;
  const compiledMtime = compiledStat.mtime?.getTime();
  if (compiledMtime === undefined) return false;
  for (const sourceStat of sourceStats) {
    const sourceMtime = sourceStat?.mtime?.getTime();
    if (sourceMtime !== undefined && compiledMtime <= sourceMtime) return false;
  }
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
  const denoDir = realDenoDir();
  const proc = new Deno.Command(BASH, {
    args: [LAUNCHER, ...args],
    env: {
      DYFJ_LAUNCHER_DRY_RUN: "1",
      DENO_DIR: denoDir,
      DYFJ_CODEX_TOOLCHAIN_PATH: "",
      DYFJ_CODEX_RUSTUP_HOME: "",
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
  it("accepts an operator-authorized executable and ignores stale optional paths", async () => {
    const node = await new Deno.Command("bash", {
      args: ["-c", "node -p process.execPath"],
      stdout: "piped",
    }).output();
    assertStrictEquals(node.success, true);
    const nodePath = new TextDecoder().decode(node.stdout).trim();
    assertObjectMatch(
      await dryRun({
        HOME: FAKE_HOME,
        DYFJ_NODE_PATH: nodePath,
      }),
      { autostart: "yes", nodePath },
    );
    assertObjectMatch(
      await dryRun({
        HOME: FAKE_HOME,
        DYFJ_NODE_PATH: "node",
      }, ["-p", "inspect"]),
      {
        autostart: "yes",
        nodePath: "",
      },
    );
    assertObjectMatch(
      await dryRun({
        HOME: FAKE_HOME,
        DYFJ_NODE_PATH: nodePath,
      }, ["--runner", "fixture", "-p", "inspect"]),
      {
        autostart: "yes",
        nodePath,
      },
    );
  });

  it("accepts an executable selected from the operator's PATH", async () => {
    const root = await Deno.realPath(
      await Deno.makeTempDir({ prefix: "dyfj-launcher-" }),
    );
    try {
      const node = `${root}/node`;
      await Deno.writeTextFile(node, "#!/bin/sh\nexit 1\n");
      await Deno.chmod(node, 0o700);
      assertObjectMatch(
        await dryRun({
          HOME: FAKE_HOME,
          DYFJ_NODE_PATH: "",
          PATH: `${root}:${Deno.env.get("PATH") ?? "/usr/bin:/bin"}`,
        }),
        { autostart: "yes", nodePath: node },
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("projects only valid explicit toolchain directories as count-only evidence", async () => {
    const directory = await Deno.realPath(
      await Deno.makeTempDir({ prefix: "dyfj-launcher-" }),
    );
    const rustupHome = await Deno.realPath(
      await Deno.makeTempDir({ prefix: "dyfj-launcher-" }),
    );
    const toolchainLink = `${directory}-link`;
    const rustupLink = `${rustupHome}-link`;
    try {
      assertStrictEquals(
        await symlink(directory, toolchainLink) &&
          await symlink(rustupHome, rustupLink),
        true,
      );
      assertObjectMatch(
        await dryRun({
          HOME: FAKE_HOME,
          DYFJ_CODEX_TOOLCHAIN_PATH: directory,
          DYFJ_CODEX_RUSTUP_HOME: rustupHome,
        }, ["--socket", "/tmp/dyfj-toolchain-test.sock", "-p", "inspect"]),
        {
          toolchainDirectories: "2",
        },
      );
      assertObjectMatch(
        await dryRun({
          HOME: FAKE_HOME,
          DYFJ_CODEX_TOOLCHAIN_PATH: directory,
          DYFJ_CODEX_RUSTUP_HOME: directory,
        }, ["--socket", "/tmp/dyfj-toolchain-test.sock", "-p", "inspect"]),
        {
          toolchainDirectories: "1",
        },
      );
      for (
        const value of ["relative", `${directory},extra`, `${directory}:extra`]
      ) {
        await assertRejects(
          () =>
            dryRun({
              HOME: FAKE_HOME,
              DYFJ_CODEX_TOOLCHAIN_PATH: value,
            }, ["--socket", "/tmp/dyfj-toolchain-test.sock", "-p", "inspect"]),
          Error,
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
        await assertRejects(
          () =>
            dryRun({
              HOME: FAKE_HOME,
              DYFJ_CODEX_RUSTUP_HOME: value,
            }, ["--socket", "/tmp/dyfj-toolchain-test.sock", "-p", "inspect"]),
          Error,
          "absolute, delimiter-safe directory",
        );
      }
      for (const value of [toolchainLink, `${toolchainLink}/`]) {
        await assertRejects(
          () =>
            dryRun({
              HOME: FAKE_HOME,
              DYFJ_CODEX_TOOLCHAIN_PATH: value,
            }, ["--socket", "/tmp/dyfj-toolchain-test.sock", "-p", "inspect"]),
          Error,
          "toolchain directory is unavailable",
        );
      }
      for (const value of ["/", "///"]) {
        await assertRejects(
          () =>
            dryRun({
              HOME: FAKE_HOME,
              DYFJ_CODEX_TOOLCHAIN_PATH: value,
            }, ["--socket", "/tmp/dyfj-toolchain-test.sock", "-p", "inspect"]),
          Error,
          "toolchain directory is unavailable",
        );
      }
      for (const value of [rustupLink, `${rustupLink}/`]) {
        await assertRejects(
          () =>
            dryRun({
              HOME: FAKE_HOME,
              DYFJ_CODEX_RUSTUP_HOME: value,
            }, ["--socket", "/tmp/dyfj-toolchain-test.sock", "-p", "inspect"]),
          Error,
          "Rustup home directory is unavailable",
        );
      }
      for (const value of ["/", "///"]) {
        await assertRejects(
          () =>
            dryRun({
              HOME: FAKE_HOME,
              DYFJ_CODEX_RUSTUP_HOME: value,
            }, ["--socket", "/tmp/dyfj-toolchain-test.sock", "-p", "inspect"]),
          Error,
          "Rustup home directory is unavailable",
        );
      }
    } finally {
      await Deno.remove(toolchainLink).catch(() => {});
      await Deno.remove(rustupLink).catch(() => {});
      await Deno.remove(directory);
      await Deno.remove(rustupHome);
    }
  });

  it(
    "rejects whole dot components before resolving toolchain directories",
    async () => {
      const root = await Deno.realPath(
        await Deno.makeTempDir({ prefix: "dyfj-launcher-" }),
      );
      const child = `${root}/child`;
      const alias = `${root}/alias`;
      const dotted = [
        `${root}/.cargo`,
        `${root}/.rustup`,
        `${root}/..cache`,
        `${root}/tool.chain`,
      ];
      try {
        await Deno.mkdir(child);
        for (const directory of dotted) await Deno.mkdir(directory);
        assertStrictEquals(await symlink(child, alias), true);
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
              await dryRun({ HOME: FAKE_HOME, [envName]: value }, [
                "--socket",
                "/tmp/dyfj-toolchain-test.sock",
                "-p",
                "inspect",
              ]);
            } catch (error) {
              failure = error instanceof Error
                ? error
                : new Error(String(error));
            }
            assertStringIncludes(failure?.message ?? "", diagnostic);
            assertFalse((failure?.message ?? "").includes(value));
          }
          for (const directory of dotted) {
            assertObjectMatch(
              await dryRun({ HOME: FAKE_HOME, [envName]: directory }, [
                "--socket",
                "/tmp/dyfj-toolchain-test.sock",
                "-p",
                "inspect",
              ]),
              { toolchainDirectories: "1" },
            );
          }
        }
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    },
  );

  it("rejects delimiter-bearing canonical toolchain paths without disclosing them", async () => {
    const root = await Deno.realPath(
      await Deno.makeTempDir({ prefix: "dyfj-launcher-" }),
    );
    const unsafeParent = `${root}/private,parent`;
    const unsafeDirectory = `${unsafeParent}/bin`;
    const safeAlias = `${root}/selected`;
    const selected = `${safeAlias}/bin`;
    try {
      await Deno.mkdir(unsafeDirectory, { recursive: true });
      assertStrictEquals(await symlink(unsafeParent, safeAlias), true);
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
            HOME: FAKE_HOME,
            [envName]: selected,
          }, ["--socket", "/tmp/dyfj-toolchain-test.sock", "-p", "inspect"]);
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
        }
        assertStringIncludes(failure?.message ?? "", diagnostic);
        assertFalse((failure?.message ?? "").includes(unsafeParent));
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("counts canonical directories whose names differ only by trailing newlines", async () => {
    const root = await Deno.realPath(
      await Deno.makeTempDir({ prefix: "dyfj-launcher-" }),
    );
    try {
      const toolchain = `${root}/toolchain`;
      const rustupHome = `${toolchain}\n`;
      await Deno.mkdir(toolchain);
      await Deno.mkdir(rustupHome);
      assertObjectMatch(
        await dryRun({
          HOME: FAKE_HOME,
          DYFJ_CODEX_TOOLCHAIN_PATH: toolchain,
          DYFJ_CODEX_RUSTUP_HOME: rustupHome,
        }, ["--socket", "/tmp/dyfj-toolchain-test.sock", "-p", "inspect"]),
        { toolchainDirectories: "2" },
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("rejects an executable directory as Node authority", async () => {
    const directory = await Deno.realPath(
      await Deno.makeTempDir({ prefix: "dyfj-launcher-" }),
    );
    try {
      assertObjectMatch(
        await dryRun({
          HOME: FAKE_HOME,
          DYFJ_NODE_PATH: directory,
        }, ["-p", "inspect"]),
        {
          autostart: "yes",
          nodePath: "",
        },
      );
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("rejects delimiter-unsafe executable paths", async () => {
    const root = await Deno.realPath(
      await Deno.makeTempDir({ prefix: "dyfj-launcher-" }),
    );
    try {
      for (const delimiter of [",", ":"]) {
        const node = `${root}/node${delimiter}unsafe`;
        await Deno.writeTextFile(node, "#!/bin/sh\nexit 0\n");
        await Deno.chmod(node, 0o700);
        assertObjectMatch(
          await dryRun({
            HOME: FAKE_HOME,
            DYFJ_NODE_PATH: node,
          }, ["-p", "inspect"]),
          {
            autostart: "yes",
            nodePath: "",
          },
        );
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("does not inspect an optional executable path for status", async () => {
    const root = await Deno.makeTempDir({ prefix: "dyfj-launcher-" });
    try {
      const marker = `${root}/invoked`;
      const node = `${root}/node`;
      await Deno.writeTextFile(node, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
      await Deno.chmod(node, 0o700);
      assertObjectMatch(
        await dryRun({
          HOME: FAKE_HOME,
          DYFJ_NODE_PATH: node,
        }, ["status"]),
        { autostart: "no" },
      );
      await assertRejects(() => Deno.stat(marker), Deno.errors.NotFound);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("does not execute the operator-selected path during discovery", async () => {
    const root = await Deno.makeTempDir({ prefix: "dyfj-launcher-" });
    try {
      const marker = `${root}/invoked`;
      const node = `${root}/node`;
      await Deno.writeTextFile(
        node,
        `#!/bin/sh\ntouch '${marker}'\nexec sleep 30\n`,
      );
      await Deno.chmod(node, 0o700);
      const startedAt = Date.now();
      assertObjectMatch(
        await dryRun({
          HOME: FAKE_HOME,
          DYFJ_NODE_PATH: node,
        }, ["-p", "inspect"]),
        { autostart: "yes" },
      );
      assertLess(Date.now() - startedAt, 3_000);
      await assertRejects(() => Deno.stat(marker), Deno.errors.NotFound);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("resolves its prototype root through a symlink chain", async () => {
    const root = await Deno.realPath(
      await Deno.makeTempDir({ prefix: "dyfj-launcher-" }),
    );

    try {
      const bin = `${root}/bin`;
      const target = `${root}/launcher`;
      const link = `${bin}/dyfj`;
      await Deno.mkdir(bin);
      for (const [from, to] of [[LAUNCHER, target], ["../launcher", link]]) {
        const setupResult = await new Deno.Command("ln", {
          args: ["-s", from, to],
          stdout: "null",
          stderr: "piped",
        }).output();
        if (setupResult.code !== 0) {
          const err = new TextDecoder().decode(setupResult.stderr).trim();
          throw new Error(`symlink setup failed (${setupResult.code}): ${err}`);
        }
      }

      const proc = new Deno.Command(BASH, {
        args: [
          link,
          "--parse-check",
          "--socket",
          `${root}/workbench.sock`,
          "models",
        ],
        env: { DYFJ_AUTOSTART: "0" },
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

  it("autostart respawns the resolved launcher source", async () => {
    const lines = (await Deno.readTextFile(LAUNCHER)).split("\n");
    const spawns = lines.filter((line) => line.includes("nohup bash "));
    assertEquals(spawns.length, 1);
    const [spawn] = spawns;
    assertStrictEquals(spawn.trimStart().startsWith("nohup bash "), true);
    assertStringIncludes(spawn, "start --launcher-autostarted");
    assertStringIncludes(spawn, '"$LAUNCHER_SOURCE"');
    assertFalse(spawn.includes("BASH_SOURCE"));
  });

  it("default path prefers compiled when the binary exists", async () => {
    const { route, sock } = await dryRun({ HOME: FAKE_HOME });
    assertStrictEquals(sock, `${FAKE_HOME}/.dyfj/run/workbench.sock`);
    if (await hasFreshCompiledBin()) {
      assertStrictEquals(route, "compiled");
    } else {
      assertStrictEquals(route, "deno");
    }
  });

  it("DYFJ_SOCKET selects deno when the path is non-default", async () => {
    const { route, sock } = await dryRun({
      HOME: FAKE_HOME,
      DYFJ_SOCKET: "/run/custom.sock",
    });
    assertStrictEquals(sock, "/run/custom.sock");
    assertStrictEquals(route, "deno");
  });

  it("XDG_RUNTIME_DIR selects deno when the path is non-default", async () => {
    const { route, sock } = await dryRun({
      HOME: FAKE_HOME,
      XDG_RUNTIME_DIR: "/run/u",
    });
    assertStrictEquals(sock, "/run/u/dyfj/workbench.sock");
    assertStrictEquals(route, "deno");
  });

  it("explicit DYFJ_SOCKET matching the default still uses compiled when present", async () => {
    const { route, sock } = await dryRun({
      HOME: FAKE_HOME,
      DYFJ_SOCKET: `${FAKE_HOME}/.dyfj/run/workbench.sock`,
    });
    assertStrictEquals(sock, `${FAKE_HOME}/.dyfj/run/workbench.sock`);
    if (await hasFreshCompiledBin()) {
      assertStrictEquals(route, "compiled");
    } else {
      assertStrictEquals(route, "deno");
    }
  });

  it("committed launcher carries no literal host path", async () => {
    const text = await Deno.readTextFile(LAUNCHER);
    assertNotMatch(text, /\/Users\//);
    assertNotMatch(text, /\/home\/[a-z]/);
  });

  it("a socket path containing spaces remains intact in dry-run evidence", async () => {
    const sock = "/tmp/dyfj workbench.sock";
    assertObjectMatch(
      await dryRun({
        HOME: FAKE_HOME,
        DYFJ_SOCKET: sock,
      }, ["--no-autostart", "status"]),
      { sock },
    );
  });

  it("dry-run validates optional paths when autostart is disabled", async () => {
    await assertRejects(
      () =>
        dryRun({
          HOME: FAKE_HOME,
          DYFJ_CODEX_TOOLCHAIN_PATH: "relative-toolchain",
        }, ["--no-autostart", "status"]),
      Error,
      "absolute, delimiter-safe directory",
    );
    await assertRejects(
      () =>
        dryRun({
          HOME: FAKE_HOME,
          DYFJ_CODEX_RUSTUP_HOME: "relative-rustup-home",
        }, ["--no-autostart", "status"]),
      Error,
      "absolute, delimiter-safe directory",
    );
  });

  it("a successful runtime probe bypasses stale optional start authority", async () => {
    const root = await Deno.realPath(
      await Deno.makeTempDir({ prefix: "dyfj-launcher-" }),
    );
    try {
      const bin = `${root}/bin`;
      const deno = `${bin}/deno`;
      await Deno.mkdir(bin);
      await Deno.writeTextFile(deno, "#!/bin/sh\nexit 0\n");
      await Deno.chmod(deno, 0o700);
      const proc = new Deno.Command(BASH, {
        args: [
          LAUNCHER,
          "--socket",
          `${root}/workbench.sock`,
          "sessions",
        ],
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          DYFJ_CODEX_TOOLCHAIN_PATH: `${root}/missing-toolchain`,
          DYFJ_CODEX_RUSTUP_HOME: `${root}/missing-rustup-home`,
          DYFJ_LAUNCHER_DRY_RUN: "",
        },
        stdout: "piped",
        stderr: "piped",
      });
      const { code, stderr } = await proc.output();
      assertStrictEquals(code, 0);
      assertFalse(new TextDecoder().decode(stderr).includes("unavailable"));
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});

describe("dyfj launcher autostart classification", () => {
  // The classification is what the dry-run seam can pin: WHEN the launcher
  // would ensure a runtime. The ensure path itself (probe, detached start,
  // readiness wait) exercises real process lifecycle and is validated in UAT.
  it("a bare invocation (REPL) autostarts", async () => {
    const { autostart } = await dryRun({ HOME: FAKE_HOME });
    assertStrictEquals(autostart, "yes");
  });
  it("an exec prompt autostarts", async () => {
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, [
      "exec",
      "hello there",
    ]);
    assertStrictEquals(autostart, "yes");
  });
  it("a prompt merely containing the word start still autostarts", async () => {
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, [
      "exec",
      "how do I start the runtime",
    ]);
    assertStrictEquals(autostart, "yes");
  });
  it("a bare positional prompt is an unknown command and declines", async () => {
    // `dyfj "hello"` is not a valid invocation — the client requires `exec`
    // or -p — so the parse-check contract correctly refuses to spawn for it.
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, ["hello there"]);
    assertStrictEquals(autostart, "no");
  });
  it("`start` never autostarts (it IS the start)", async () => {
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, ["start"]);
    assertStrictEquals(autostart, "no");
  });
  it("`status` stays an honest reporter", async () => {
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, ["status"]);
    assertStrictEquals(autostart, "no");
  });
  it("`stop` never triggers autostart", async () => {
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, ["stop"]);
    assertStrictEquals(autostart, "no");
  });
  it("help never needs a runtime", async () => {
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, ["--help"]);
    assertStrictEquals(autostart, "no");
  });
  it("retired HTTP transport flags decline autostart as unknown", async () => {
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, [
      "--server",
      "http://127.0.0.1:18080",
    ]);
    assertStrictEquals(autostart, "no");
  });
  it("--no-autostart opts out per call", async () => {
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, ["--no-autostart"]);
    assertStrictEquals(autostart, "no");
  });
  it("DYFJ_AUTOSTART=0 opts out standing", async () => {
    const { autostart } = await dryRun({
      HOME: FAKE_HOME,
      DYFJ_AUTOSTART: "0",
    });
    assertStrictEquals(autostart, "no");
  });
  it("a custom socket still autostarts (on that socket)", async () => {
    const { autostart, route } = await dryRun({
      HOME: FAKE_HOME,
      DYFJ_SOCKET: "/run/custom.sock",
    });
    assertStrictEquals(autostart, "yes");
    assertStrictEquals(route, "deno");
  });
});

describe("autostart classification is position-aware and socket-coherent", () => {
  it("an explicit --socket drives the launcher's own resolution", async () => {
    const { sock, route, autostart } = await dryRun({ HOME: FAKE_HOME }, [
      "--socket",
      "/run/explicit.sock",
    ]);
    assertStrictEquals(sock, "/run/explicit.sock");
    assertStrictEquals(route, "deno");
    assertStrictEquals(autostart, "yes");
  });
  it("--socket beats DYFJ_SOCKET", async () => {
    const { sock } = await dryRun(
      { HOME: FAKE_HOME, DYFJ_SOCKET: "/run/env.sock" },
      ["--socket", "/run/flag.sock"],
    );
    assertStrictEquals(sock, "/run/flag.sock");
  });
  it("a -p prompt that is literally the word start still autostarts", async () => {
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, ["-p", "start"]);
    assertStrictEquals(autostart, "yes");
  });
  it("a --model value named status is a value, not a subcommand", async () => {
    // --model takes an arbitrary slug, so this pins value-position handling
    // without tripping the client's session-ref validation (a --session value
    // of "status" is genuinely invalid there, and correctly declines).
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, [
      "--model",
      "status",
    ]);
    assertStrictEquals(autostart, "yes");
  });
});

describe("prompt values cannot become launcher control input", () => {
  // Adversarial argument shapes: an argument in a value slot that LOOKS like
  // a launcher flag must be data, never control.
  it("a -p prompt of --socket does not capture the next arg as a socket", async () => {
    const { sock, autostart } = await dryRun({ HOME: FAKE_HOME }, [
      "-p",
      "--socket",
      "--model",
      "foo",
    ]);
    assertStrictEquals(sock, `${FAKE_HOME}/.dyfj/run/workbench.sock`);
    assertStrictEquals(autostart, "yes");
  });
  it("a -p prompt of --no-autostart does not opt out", async () => {
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, [
      "-p",
      "--no-autostart",
      "--model",
      "foo",
    ]);
    assertStrictEquals(autostart, "yes");
  });
  it("a -p prompt of --help does not suppress autostart", async () => {
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, ["-p", "--help"]);
    assertStrictEquals(autostart, "yes");
  });
  it("a -p prompt of -h does not suppress autostart", async () => {
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, ["-p", "-h"]);
    assertStrictEquals(autostart, "yes");
  });
  it("a control-position --help still opts out", async () => {
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, ["--help"]);
    assertStrictEquals(autostart, "no");
  });
  it("a -p prompt of --server does not decline autostart", async () => {
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, [
      "-p",
      "--server",
      "--model",
      "foo",
    ]);
    assertStrictEquals(autostart, "yes");
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
      // The real Deno cache, so the fake HOME never means a cold one.
      env: { DENO_DIR: realDenoDir(), ...env, DYFJ_LAUNCHER_DRY_RUN: "" },
      stdout: "null",
      stderr: "piped",
    });
    const { code, stderr } = await proc.output();
    return { code, err: new TextDecoder().decode(stderr) };
  }

  it("empty HOME declines instead of logging into the cwd", async () => {
    const cwd = await Deno.makeTempDir({ prefix: "dyfj-launcher-" });
    try {
      // A socket that certainly is not answering, so the ensure path runs.
      const { code, err } = await runReal(
        { HOME: "", DYFJ_SOCKET: `${cwd}/x.sock` },
        cwd,
      );
      assertNotStrictEquals(code, 0);
      assertStringIncludes(err, "absolute HOME");
      // Nothing durable appears in the invoking directory.
      const entries: string[] = [];
      for await (const e of Deno.readDir(cwd)) entries.push(e.name);
      assertFalse(entries.includes(".dyfj"));
    } finally {
      await Deno.remove(cwd, { recursive: true });
    }
  });

  it("relative HOME declines the same way", async () => {
    const cwd = await Deno.makeTempDir({ prefix: "dyfj-launcher-" });
    try {
      const { code, err } = await runReal(
        { HOME: "relative/home", DYFJ_SOCKET: `${cwd}/x.sock` },
        cwd,
      );
      assertNotStrictEquals(code, 0);
      assertStringIncludes(err, "absolute HOME");
    } finally {
      await Deno.remove(cwd, { recursive: true });
    }
  });
});

describe("an invocation the client's parser rejects never triggers autostart", () => {
  it("an unknown flag declines autostart", async () => {
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, ["--bogus"]);
    assertStrictEquals(autostart, "no");
  });
  it("an invalid enum value declines autostart", async () => {
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, ["--tier", "3"]);
    assertStrictEquals(autostart, "no");
  });
  it("an explicitly empty --socket declines autostart", async () => {
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, ["--socket", ""]);
    assertStrictEquals(autostart, "no");
  });
  it("a value flag with no value declines autostart", async () => {
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, ["--socket"]);
    assertStrictEquals(autostart, "no");
  });
  it("a bare -p declines autostart", async () => {
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, ["-p"]);
    assertStrictEquals(autostart, "no");
  });
});

describe("a -p prompt makes the invocation a turn the runtime is needed for", () => {
  it("status alongside -p does not suppress the runtime the turn needs", async () => {
    // The client resolves a prompt before subcommands, so this is a turn, not
    // the `status` report — suppressing autostart leaves it failing against
    // nothing.
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, [
      "-p",
      "status of the build",
      "status",
    ]);
    assertStrictEquals(autostart, "yes");
  });

  it("a help FLAG wins over a prompt", async () => {
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, [
      "--help",
      "-p",
      "hello",
    ]);
    assertStrictEquals(autostart, "no");
  });

  it("a positional help alongside a prompt is a turn, matching the client", async () => {
    // parseArgs gives help precedence to the -h/--help FLAG state only: a
    // populated -p returns an exec command before positional-command
    // validation, so this invocation is a print turn and needs a runtime.
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, [
      "help",
      "-p",
      "hello",
    ]);
    assertStrictEquals(autostart, "yes");
  });
});

describe("the probe invokes the client on the UDS seam", () => {
  it("both client routes invoke status without a retired transport flag", async () => {
    const lines = (await Deno.readTextFile(LAUNCHER)).split("\n");
    const open = lines.findIndex((l) => l.trim() === "probe_runtime() {");
    assertGreaterOrEqual(open, 0);
    const close = lines.findIndex((l, i) => i > open && l === "}");
    assertGreater(close, open);
    const body = lines.slice(open, close);
    const invocations = body.filter((l) =>
      l.trimEnd().endsWith("status >/dev/null 2>&1")
    );
    // One per route — compiled and deno. A third would be an unreviewed call.
    assertEquals(invocations.length, 2);
    for (const line of invocations) {
      assertStringIncludes(line, " status ");
      assertFalse(line.includes("--unix"));
      assertFalse(line.includes("--server"));
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
  it(
    "an active in-flight start lock prevents spawning a second start process",
    async () => {
      const home = await Deno.realPath(
        await Deno.makeTempDir({ prefix: "dyfj-launcher-" }),
      );
      const sock = `${home}/test-runtime.sock`;
      const base = "test-runtime";
      const hashProc = new Deno.Command(BASH, {
        args: [
          "-c",
          'h=$(printf "%s" "$1" | shasum -a 256 2>/dev/null | cut -c1-16); [[ -n "$h" ]] && echo "$h" || printf "%s" "$1" | cksum | cut -d" " -f1',
          "bash",
          sock,
        ],
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
          HOME: home,
          // The probe runs the client, whose Deno cache would otherwise
          // follow the fake HOME and start empty: a slow dependency fetch
          // could then outlast the lock's TTL before the lock is read.
          DENO_DIR: realDenoDir(),
          DYFJ_SOCKET: sock,
          DYFJ_START_LOCK_TTL_SEC: "30",
          DYFJ_LAUNCHER_DRY_RUN: "",
        },
        stdout: "null",
        stderr: "piped",
      }).spawn();

      const reader = proc.stderr.getReader();
      try {
        const errText = await readUntilStderr(reader, "already in flight");
        assertStringIncludes(errText, "already in flight");
        assertFalse(errText.includes("runtime not running at"));
        const lockContent = await Deno.readTextFile(lockFile);
        assertStrictEquals(lockContent.trim(), `${nowSec}`);
      } finally {
        // Release the piped stderr so the child's stream is not left open.
        await reader.cancel().catch(() => {});
        try {
          proc.kill("SIGTERM");
          await proc.status;
        } catch {
          // ignore
        }
        await reapPidsAndCommandsContaining([proc.pid], sock);
        await safeRemove(home);
      }
    },
  );

  it(
    "a stale in-flight start lock (> TTL) is overwritten and allows a fresh start",
    async () => {
      const home = await Deno.realPath(
        await Deno.makeTempDir({ prefix: "dyfj-launcher-" }),
      );
      const sock = `${home}/test-runtime.sock`;
      const base = "test-runtime";
      const hashProc = new Deno.Command(BASH, {
        args: [
          "-c",
          'h=$(printf "%s" "$1" | shasum -a 256 2>/dev/null | cut -c1-16); [[ -n "$h" ]] && echo "$h" || printf "%s" "$1" | cksum | cut -d" " -f1',
          "bash",
          sock,
        ],
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
          HOME: home,
          // The probe runs the client, whose Deno cache would otherwise
          // follow the fake HOME and start empty: a slow dependency fetch
          // could then outlast the lock's TTL before the lock is read.
          DENO_DIR: realDenoDir(),
          DYFJ_SOCKET: sock,
          DYFJ_START_LOCK_TTL_SEC: "30",
          DYFJ_LAUNCHER_DRY_RUN: "",
        },
        stdout: "null",
        stderr: "piped",
      }).spawn();

      const reader = proc.stderr.getReader();
      try {
        const errText = await readUntilStderr(reader, "runtime not running at");
        assertStringIncludes(errText, "runtime not running at");
        assertFalse(errText.includes("already in flight"));
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
          assertGreaterOrEqual(updatedTs, beforeSec);
        }
        if (spawnedPid !== undefined) {
          assertGreater(spawnedPid, 0);
        }
      } finally {
        // Release the piped stderr so the child's stream is not left open.
        await reader.cancel().catch(() => {});
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
    },
  );

  it(
    "an in-flight start lock with an active living process suppresses duplicate spawn",
    async () => {
      const home = await Deno.realPath(
        await Deno.makeTempDir({ prefix: "dyfj-launcher-" }),
      );
      const sock = `${home}/test-runtime.sock`;
      const base = "test-runtime";
      const hashProc = new Deno.Command(BASH, {
        args: [
          "-c",
          'h=$(printf "%s" "$1" | shasum -a 256 2>/dev/null | cut -c1-16); [[ -n "$h" ]] && echo "$h" || printf "%s" "$1" | cksum | cut -d" " -f1',
          "bash",
          sock,
        ],
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
          HOME: home,
          // The probe runs the client, whose Deno cache would otherwise
          // follow the fake HOME and start empty: a slow dependency fetch
          // could then outlast the lock's TTL before the lock is read.
          DENO_DIR: realDenoDir(),
          DYFJ_SOCKET: sock,
          DYFJ_START_LOCK_TTL_SEC: "30",
          DYFJ_LAUNCHER_DRY_RUN: "",
        },
        stdout: "null",
        stderr: "piped",
      }).spawn();

      const reader = proc.stderr.getReader();
      try {
        const errText = await readUntilStderr(reader, "already in flight");
        assertStringIncludes(errText, "already in flight");
        assertFalse(errText.includes("runtime not running at"));
      } finally {
        // Release the piped stderr so the child's stream is not left open.
        await reader.cancel().catch(() => {});
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
    },
  );
});

describe("interactive REPL front-end selection", () => {
  // A stand-in for the Rust REPL: executable, never run in dry-run mode.
  async function fakeReplBin(): Promise<string> {
    const dir = await Deno.makeTempDir();
    const bin = `${dir}/dyfj-repl`;
    await Deno.writeTextFile(bin, "#!/bin/sh\nexit 0\n");
    await Deno.chmod(bin, 0o755);
    return bin;
  }

  async function launch(
    env: Record<string, string>,
    args: string[],
  ): Promise<{ code: number; out: string; err: string }> {
    const { code, stdout, stderr } = await new Deno.Command(BASH, {
      args: [LAUNCHER, ...args],
      env: {
        DYFJ_LAUNCHER_DRY_RUN: "1",
        DENO_DIR: realDenoDir(),
        DYFJ_CODEX_TOOLCHAIN_PATH: "",
        DYFJ_CODEX_RUSTUP_HOME: "",
        HOME: FAKE_HOME,
        ...env,
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
    return { code, out: decode(stdout), err: decode(stderr) };
  }

  it("routes a bare session with REPL flags to the Rust REPL", async () => {
    const bin = await fakeReplBin();
    const { code, out } = await launch(
      { DYFJ_REPL: "rust", DYFJ_REPL_BIN: bin },
      ["--model", "z-ai/glm-5.2", "--approve-paid", "--socket", "/tmp/r.sock"],
    );
    assertStrictEquals(code, 0);
    assertStringIncludes(out, "route=rust_repl");
  });

  it("keeps the TypeScript REPL off a terminal unless DYFJ_REPL=rust", async () => {
    const bin = await fakeReplBin();
    const { out } = await launch({ DYFJ_REPL_BIN: bin }, []);
    assertNotMatch(out, /route=rust_repl/);
  });

  it("leaves subcommands and prompts alone whatever DYFJ_REPL says", async () => {
    const bin = await fakeReplBin();
    for (const args of [["status"], ["-p", "hi"], ["--help"]]) {
      const { code, out } = await launch(
        { DYFJ_REPL: "rust", DYFJ_REPL_BIN: bin },
        args,
      );
      assertStrictEquals(code, 0, args.join(" "));
      assertNotMatch(out, /route=rust_repl/);
    }
  });

  it("DYFJ_REPL=rust refuses a session the Rust REPL cannot take", async () => {
    const bin = await fakeReplBin();
    const tsOnly = await launch(
      { DYFJ_REPL: "rust", DYFJ_REPL_BIN: bin },
      ["--tier", "1"],
    );
    assertStrictEquals(tsOnly.code, 2);
    assertStringIncludes(tsOnly.err, "only the TypeScript REPL takes");

    const missing = await launch(
      { DYFJ_REPL: "rust", DYFJ_REPL_BIN: "/nonexistent/dyfj-repl" },
      [],
    );
    assertStrictEquals(missing.code, 2);
    assertStringIncludes(missing.err, "no dyfj-repl binary");

    const ts = await launch({ DYFJ_REPL: "ts", DYFJ_REPL_BIN: bin }, []);
    assertNotMatch(ts.out, /route=rust_repl/);
  });
});

describe("socket-path grant delimiter safety", () => {
  async function launchExpectingRejection(
    env: Record<string, string>,
    args: string[],
  ): Promise<{ code: number; err: string }> {
    const { code, stderr } = await new Deno.Command(BASH, {
      args: [LAUNCHER, ...args],
      env: {
        DYFJ_LAUNCHER_DRY_RUN: "1",
        ...env,
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    return { code, err: new TextDecoder().decode(stderr) };
  }

  it("a comma-bearing DYFJ_SOCKET fails closed before any grant is built", async () => {
    const { code, err } = await launchExpectingRejection(
      { DYFJ_SOCKET: "/tmp/x.sock,example.invalid:443" },
      ["status"],
    );
    assertNotStrictEquals(code, 0);
    assertStringIncludes(err, "must not contain a comma");
    // Content-free: the rejected value (which may carry private path content
    // or control bytes) must not be echoed back.
    assertFalse(err.includes("example.invalid"));
  });

  it("the rejection is content-free for control-bearing values", async () => {
    const { code, err } = await launchExpectingRejection(
      { DYFJ_SOCKET: "/tmp/\u001b[2Jevil,x.sock" },
      ["status"],
    );
    assertNotStrictEquals(code, 0);
    assertStringIncludes(err, "must not contain a comma");
    assertFalse(err.includes("evil"));
    assertFalse(err.includes("\u001b"));
  });

  it("a comma-bearing --socket flag fails closed before any grant is built", async () => {
    const { code, err } = await launchExpectingRejection(
      {},
      ["--socket", "/tmp/x.sock,example.invalid:443", "status"],
    );
    assertNotStrictEquals(code, 0);
    assertStringIncludes(err, "must not contain a comma");
  });

  it("a comma-bearing XDG_RUNTIME_DIR fails closed before any grant is built", async () => {
    const { code, err } = await launchExpectingRejection(
      { XDG_RUNTIME_DIR: "/tmp/x,evil" },
      ["status"],
    );
    assertNotStrictEquals(code, 0);
    assertStringIncludes(err, "must not contain a comma");
  });
});

describe("compile-cli grant construction", () => {
  async function compileWithHome(
    home: string,
  ): Promise<{ code: number; err: string }> {
    const cwd = new URL("..", import.meta.url).pathname;
    const denoBin = Deno.env.get("DENO_BIN");
    const denoDir = realDenoDir();
    if (!denoBin) {
      throw new Error("DENO_BIN must name the selected Deno executable");
    }
    const { code, stderr } = await new Deno.Command(denoBin, {
      args: ["task", "compile-cli"],
      cwd,
      env: { HOME: home, DENO_DIR: denoDir },
      stdout: "piped",
      stderr: "piped",
    }).output();
    return { code, err: new TextDecoder().decode(stderr) };
  }

  it("whitespace in HOME fails closed before any compile", async () => {
    const { code, err } = await compileWithHome("/tmp/has space");
    assertNotStrictEquals(code, 0);
    assertStringIncludes(err, "free of commas and whitespace");
  });

  it("a comma in HOME fails closed before any compile", async () => {
    const { code, err } = await compileWithHome("/tmp/has,comma");
    assertNotStrictEquals(code, 0);
    assertStringIncludes(err, "free of commas and whitespace");
  });

  it("a relative HOME fails closed before any compile", async () => {
    const { code, err } = await compileWithHome("relative/home");
    assertNotStrictEquals(code, 0);
    assertStringIncludes(err, "absolute home path");
  });
});
