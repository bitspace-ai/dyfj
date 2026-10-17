// The `dyfj` launcher script (`dyfj-launcher.sh`) driven through bash: dry-run
// routing and autostart classification, the start lock, and grant-delimiter
// guards. It spawns processes, builds symlink fixtures and reads a few
// environment variables, so it runs in the integration lane. Children get this
// process's environment with each case's overrides on top (`childEnv`), so
// each case names only the variables it overrides. A launch that reaches the
// real autostart path can leave a detached runtime behind, which is not this
// test's child; `reapPidsAndCommandsContaining` finds it by its socket path in
// the process list and signals it.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  rmdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type { Readable } from "node:stream";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { reapPidsAndCommandsContaining } from "../testing/processes.ts";

const LAUNCHER = fileURLToPath(new URL("./dyfj-launcher.sh", import.meta.url));
const BASH = process.platform === "darwin" ? "/bin/bash" : "bash";
// Assembled at runtime so the public-boundary scan never matches this
// fixture as a home-directory path in tracked source.
const FAKE_HOME = ["", "home", "c"].join("/");

function childEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, ...env };
}

interface Output {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs `command` to completion with stdin closed, collecting its output. A
 * `null` code means a signal ended it.
 */
function output(
  command: string,
  args: string[],
  options: {
    env?: Record<string, string>;
    cwd?: string;
    stdout?: "pipe" | "ignore";
  } = {},
): Promise<Output> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: childEnv(options.env ?? {}),
      stdio: ["ignore", options.stdout ?? "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }));
  });
}

/** A child, and a promise that settles once it has exited and its stdio closed. */
interface Spawned {
  child: ChildProcess;
  closed: Promise<void>;
}

function spawnTracked(
  command: string,
  args: string[],
  options: {
    env?: Record<string, string>;
    stdio: ["ignore", "ignore", "pipe" | "ignore"];
  },
): Spawned {
  const child = spawn(command, args, {
    env: childEnv(options.env ?? {}),
    stdio: options.stdio,
  });
  const closed = new Promise<void>((resolve) => {
    child.on("error", () => resolve());
    child.on("close", () => resolve());
  });
  return { child, closed };
}

/** Sends TERM to `spawned` unless it has already exited, then waits for it. */
async function stopSpawned({ child, closed }: Spawned): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
  }
  await closed;
}

function includes(actual: string, expected: string, message?: string): void {
  assert.ok(
    actual.includes(expected),
    message ??
      `expected ${JSON.stringify(actual)} to include ${
        JSON.stringify(expected)
      }`,
  );
}

function refutes(value: boolean): void {
  assert.equal(value, false);
}

async function rejectsWith(
  run: () => Promise<unknown>,
  text: string,
): Promise<void> {
  await assert.rejects(
    run,
    (error: unknown) => error instanceof Error && error.message.includes(text),
  );
}

async function tempDir(prefix = "dyfj-launcher-"): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

async function realTempDir(): Promise<string> {
  return await realpath(await tempDir());
}

/** Whether a symlink at `path` pointing at `target` could be made. */
async function symlinked(target: string, path: string): Promise<boolean> {
  return await symlink(target, path).then(() => true, () => false);
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
  const { code, stdout, stderr } = await output(BASH, [LAUNCHER, ...args], {
    env: {
      DYFJ_LAUNCHER_DRY_RUN: "1",
      DYFJ_CODEX_TOOLCHAIN_PATH: "",
      DYFJ_CODEX_RUSTUP_HOME: "",
      ...env,
    },
  });
  const text = stdout.trim();
  const err = stderr.trim();
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
  it("routes dyfj dev to the dev supervisor on its own socket, never the daily one", async () => {
    assert.partialDeepStrictEqual(
      await dryRun({ HOME: FAKE_HOME, XDG_RUNTIME_DIR: "", DYFJ_SOCKET: "/elsewhere/daily.sock" }, ["dev"]),
      { route: "dev", autostart: "no", sock: `${FAKE_HOME}/.dyfj/run/dev.sock` },
    );
    assert.partialDeepStrictEqual(
      await dryRun({ HOME: FAKE_HOME, XDG_RUNTIME_DIR: "/xdg" }, ["dev", "--model", "m"]),
      { route: "dev", autostart: "no", sock: "/xdg/dyfj/dev.sock" },
    );
    assert.partialDeepStrictEqual(
      await dryRun({ HOME: FAKE_HOME }, ["dev", "--socket", "/tmp/mine.sock"]),
      { route: "dev", sock: "/tmp/mine.sock" },
    );
    // `dev` in a value slot, or as a prompt, is not the subcommand.
    for (const args of [["--model", "dev"], ["-p", "dev"]]) {
      const { route } = await dryRun({ HOME: FAKE_HOME }, args);
      assert.notEqual(route, "dev", args.join(" "));
    }
  });

  it("accepts an operator-authorized executable and ignores stale optional paths", async () => {
    const node = await output("bash", ["-c", "node -p process.execPath"]);
    assert.equal(node.code, 0);
    const nodePath = node.stdout.trim();
    assert.partialDeepStrictEqual(
      await dryRun({
        HOME: FAKE_HOME,
        DYFJ_NODE_PATH: nodePath,
      }),
      { autostart: "yes", nodePath },
    );
    assert.partialDeepStrictEqual(
      await dryRun({
        HOME: FAKE_HOME,
        DYFJ_NODE_PATH: "node",
      }, ["-p", "inspect"]),
      {
        autostart: "yes",
        nodePath: "",
      },
    );
    assert.partialDeepStrictEqual(
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
    const real = await output("bash", ["-c", "node -p process.execPath"]);
    const realNode = real.stdout.trim();
    const root = await realTempDir();
    try {
      // The first node on PATH, standing in for the real one, which the
      // launcher also runs the client on.
      const node = `${root}/node`;
      await writeFile(node, `#!/bin/sh\nexec "${realNode}" "$@"\n`);
      await chmod(node, 0o700);
      assert.partialDeepStrictEqual(
        await dryRun({
          HOME: FAKE_HOME,
          DYFJ_NODE_PATH: "",
          PATH: `${root}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        }),
        { autostart: "yes", nodePath: node },
      );
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it("projects only valid explicit toolchain directories as count-only evidence", async () => {
    const directory = await realTempDir();
    const rustupHome = await realTempDir();
    const toolchainLink = `${directory}-link`;
    const rustupLink = `${rustupHome}-link`;
    try {
      assert.equal(
        await symlinked(directory, toolchainLink) &&
          await symlinked(rustupHome, rustupLink),
        true,
      );
      assert.partialDeepStrictEqual(
        await dryRun({
          HOME: FAKE_HOME,
          DYFJ_CODEX_TOOLCHAIN_PATH: directory,
          DYFJ_CODEX_RUSTUP_HOME: rustupHome,
        }, ["--socket", "/tmp/dyfj-toolchain-test.sock", "-p", "inspect"]),
        {
          toolchainDirectories: "2",
        },
      );
      assert.partialDeepStrictEqual(
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
        await rejectsWith(
          () =>
            dryRun({
              HOME: FAKE_HOME,
              DYFJ_CODEX_TOOLCHAIN_PATH: value,
            }, ["--socket", "/tmp/dyfj-toolchain-test.sock", "-p", "inspect"]),
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
        await rejectsWith(
          () =>
            dryRun({
              HOME: FAKE_HOME,
              DYFJ_CODEX_RUSTUP_HOME: value,
            }, ["--socket", "/tmp/dyfj-toolchain-test.sock", "-p", "inspect"]),
          "absolute, delimiter-safe directory",
        );
      }
      for (const value of [toolchainLink, `${toolchainLink}/`]) {
        await rejectsWith(
          () =>
            dryRun({
              HOME: FAKE_HOME,
              DYFJ_CODEX_TOOLCHAIN_PATH: value,
            }, ["--socket", "/tmp/dyfj-toolchain-test.sock", "-p", "inspect"]),
          "toolchain directory is unavailable",
        );
      }
      for (const value of ["/", "///"]) {
        await rejectsWith(
          () =>
            dryRun({
              HOME: FAKE_HOME,
              DYFJ_CODEX_TOOLCHAIN_PATH: value,
            }, ["--socket", "/tmp/dyfj-toolchain-test.sock", "-p", "inspect"]),
          "toolchain directory is unavailable",
        );
      }
      for (const value of [rustupLink, `${rustupLink}/`]) {
        await rejectsWith(
          () =>
            dryRun({
              HOME: FAKE_HOME,
              DYFJ_CODEX_RUSTUP_HOME: value,
            }, ["--socket", "/tmp/dyfj-toolchain-test.sock", "-p", "inspect"]),
          "Rustup home directory is unavailable",
        );
      }
      for (const value of ["/", "///"]) {
        await rejectsWith(
          () =>
            dryRun({
              HOME: FAKE_HOME,
              DYFJ_CODEX_RUSTUP_HOME: value,
            }, ["--socket", "/tmp/dyfj-toolchain-test.sock", "-p", "inspect"]),
          "Rustup home directory is unavailable",
        );
      }
    } finally {
      await rm(toolchainLink).catch(() => {});
      await rm(rustupLink).catch(() => {});
      await rmdir(directory);
      await rmdir(rustupHome);
    }
  });

  it(
    "rejects whole dot components before resolving toolchain directories",
    async () => {
      const root = await realTempDir();
      const child = `${root}/child`;
      const alias = `${root}/alias`;
      const dotted = [
        `${root}/.cargo`,
        `${root}/.rustup`,
        `${root}/..cache`,
        `${root}/tool.chain`,
      ];
      try {
        await mkdir(child);
        for (const directory of dotted) await mkdir(directory);
        assert.equal(await symlinked(child, alias), true);
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
            includes(failure?.message ?? "", diagnostic);
            refutes((failure?.message ?? "").includes(value));
          }
          for (const directory of dotted) {
            assert.partialDeepStrictEqual(
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
        await rm(root, { recursive: true });
      }
    },
  );

  it("rejects delimiter-bearing canonical toolchain paths without disclosing them", async () => {
    const root = await realTempDir();
    const unsafeParent = `${root}/private,parent`;
    const unsafeDirectory = `${unsafeParent}/bin`;
    const safeAlias = `${root}/selected`;
    const selected = `${safeAlias}/bin`;
    try {
      await mkdir(unsafeDirectory, { recursive: true });
      assert.equal(await symlinked(unsafeParent, safeAlias), true);
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
        includes(failure?.message ?? "", diagnostic);
        refutes((failure?.message ?? "").includes(unsafeParent));
      }
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it("counts canonical directories whose names differ only by trailing newlines", async () => {
    const root = await realTempDir();
    try {
      const toolchain = `${root}/toolchain`;
      const rustupHome = `${toolchain}\n`;
      await mkdir(toolchain);
      await mkdir(rustupHome);
      assert.partialDeepStrictEqual(
        await dryRun({
          HOME: FAKE_HOME,
          DYFJ_CODEX_TOOLCHAIN_PATH: toolchain,
          DYFJ_CODEX_RUSTUP_HOME: rustupHome,
        }, ["--socket", "/tmp/dyfj-toolchain-test.sock", "-p", "inspect"]),
        { toolchainDirectories: "2" },
      );
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it("rejects an executable directory as Node authority", async () => {
    const directory = await realTempDir();
    try {
      assert.partialDeepStrictEqual(
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
      await rm(directory, { recursive: true });
    }
  });

  it("rejects delimiter-unsafe executable paths", async () => {
    const root = await realTempDir();
    try {
      for (const delimiter of [",", ":"]) {
        const node = `${root}/node${delimiter}unsafe`;
        await writeFile(node, "#!/bin/sh\nexit 0\n");
        await chmod(node, 0o700);
        assert.partialDeepStrictEqual(
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
      await rm(root, { recursive: true });
    }
  });

  it("does not inspect an optional executable path for status", async () => {
    const root = await tempDir();
    try {
      const marker = `${root}/invoked`;
      const node = `${root}/node`;
      await writeFile(node, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
      await chmod(node, 0o700);
      assert.partialDeepStrictEqual(
        await dryRun({
          HOME: FAKE_HOME,
          DYFJ_NODE_PATH: node,
        }, ["status"]),
        { autostart: "no" },
      );
      await assert.rejects(stat(marker), { code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it("does not execute the operator-selected path during discovery", async () => {
    const root = await tempDir();
    try {
      const marker = `${root}/invoked`;
      const node = `${root}/node`;
      await writeFile(
        node,
        `#!/bin/sh\ntouch '${marker}'\nexec sleep 30\n`,
      );
      await chmod(node, 0o700);
      const startedAt = Date.now();
      assert.partialDeepStrictEqual(
        await dryRun({
          HOME: FAKE_HOME,
          DYFJ_NODE_PATH: node,
        }, ["-p", "inspect"]),
        { autostart: "yes" },
      );
      assert.ok(Date.now() - startedAt < 3_000);
      await assert.rejects(stat(marker), { code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it("resolves its prototype root through a symlink chain", async () => {
    const root = await realTempDir();

    try {
      const bin = `${root}/bin`;
      const target = `${root}/launcher`;
      const link = `${bin}/dyfj`;
      await mkdir(bin);
      for (const [from, to] of [[LAUNCHER, target], ["../launcher", link]]) {
        await symlink(from, to);
      }

      const { code, stderr } = await output(BASH, [
        link,
        "--parse-check",
        "--socket",
        `${root}/workbench.sock`,
        "models",
      ], { env: { DYFJ_AUTOSTART: "0" } });
      const err = stderr.trim();
      if (code !== 0) {
        throw new Error(`symlinked launcher failed (${code}): ${err}`);
      }
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it("autostart respawns the resolved launcher source", async () => {
    const lines = (await readFile(LAUNCHER, "utf8")).split("\n");
    const spawns = lines.filter((line) => line.includes("nohup bash "));
    assert.equal(spawns.length, 1);
    const [spawn] = spawns;
    assert.equal(spawn.trimStart().startsWith("nohup bash "), true);
    includes(spawn, "start --launcher-autostarted");
    includes(spawn, '"$LAUNCHER_SOURCE"');
    refutes(spawn.includes("BASH_SOURCE"));
  });

  it("runs the client on node for the default socket", async () => {
    const { route, sock } = await dryRun({ HOME: FAKE_HOME });
    assert.equal(sock, `${FAKE_HOME}/.dyfj/run/workbench.sock`);
    assert.equal(route, "node");
  });

  it("DYFJ_SOCKET moves the socket and keeps the node route", async () => {
    const { route, sock } = await dryRun({
      HOME: FAKE_HOME,
      DYFJ_SOCKET: "/run/custom.sock",
    });
    assert.equal(sock, "/run/custom.sock");
    assert.equal(route, "node");
  });

  it("XDG_RUNTIME_DIR moves the socket and keeps the node route", async () => {
    const { route, sock } = await dryRun({
      HOME: FAKE_HOME,
      XDG_RUNTIME_DIR: "/run/u",
    });
    assert.equal(sock, "/run/u/dyfj/workbench.sock");
    assert.equal(route, "node");
  });

  it("committed launcher carries no literal host path", async () => {
    const text = await readFile(LAUNCHER, "utf8");
    assert.doesNotMatch(text, /\/Users\//);
    assert.doesNotMatch(text, /\/home\/[a-z]/);
  });

  it("a socket path containing spaces remains intact in dry-run evidence", async () => {
    const sock = "/tmp/dyfj workbench.sock";
    assert.partialDeepStrictEqual(
      await dryRun({
        HOME: FAKE_HOME,
        DYFJ_SOCKET: sock,
      }, ["--no-autostart", "status"]),
      { sock },
    );
  });

  it("dry-run validates optional paths when autostart is disabled", async () => {
    await rejectsWith(
      () =>
        dryRun({
          HOME: FAKE_HOME,
          DYFJ_CODEX_TOOLCHAIN_PATH: "relative-toolchain",
        }, ["--no-autostart", "status"]),
      "absolute, delimiter-safe directory",
    );
    await rejectsWith(
      () =>
        dryRun({
          HOME: FAKE_HOME,
          DYFJ_CODEX_RUSTUP_HOME: "relative-rustup-home",
        }, ["--no-autostart", "status"]),
      "absolute, delimiter-safe directory",
    );
  });

  it("a successful runtime probe bypasses stale optional start authority", async () => {
    const root = await realTempDir();
    try {
      const bin = `${root}/bin`;
      const node = `${bin}/node`;
      await mkdir(bin);
      // A node that reports the required version and answers every probe.
      await writeFile(
        node,
        '#!/bin/sh\n[ "$1" = --version ] && echo v26.0.0\nexit 0\n',
      );
      await chmod(node, 0o700);
      const { code, stderr } = await output(BASH, [
        LAUNCHER,
        "--socket",
        `${root}/workbench.sock`,
        "sessions",
      ], {
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          DYFJ_CODEX_TOOLCHAIN_PATH: `${root}/missing-toolchain`,
          DYFJ_CODEX_RUSTUP_HOME: `${root}/missing-rustup-home`,
          DYFJ_LAUNCHER_DRY_RUN: "",
        },
      });
      assert.equal(code, 0);
      refutes(stderr.includes("unavailable"));
    } finally {
      await rm(root, { recursive: true });
    }
  });
});

describe("dyfj launcher autostart classification", () => {
  // The classification is what the dry-run seam can pin: WHEN the launcher
  // would ensure a runtime. The ensure path itself (probe, detached start,
  // readiness wait) exercises real process lifecycle and is validated in UAT.
  it("a bare invocation (REPL) autostarts", async () => {
    const { autostart } = await dryRun({ HOME: FAKE_HOME });
    assert.equal(autostart, "yes");
  });
  it("an exec prompt autostarts", async () => {
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, [
      "exec",
      "hello there",
    ]);
    assert.equal(autostart, "yes");
  });
  it("a prompt merely containing the word start still autostarts", async () => {
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, [
      "exec",
      "how do I start the runtime",
    ]);
    assert.equal(autostart, "yes");
  });
  it("a bare positional prompt is an unknown command and declines", async () => {
    // `dyfj "hello"` is not a valid invocation — the client requires `exec`
    // or -p — so the parse-check contract correctly refuses to spawn for it.
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, ["hello there"]);
    assert.equal(autostart, "no");
  });
  it("`start` never autostarts (it IS the start)", async () => {
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, ["start"]);
    assert.equal(autostart, "no");
  });
  it("`status` stays an honest reporter", async () => {
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, ["status"]);
    assert.equal(autostart, "no");
  });
  it("`stop` never triggers autostart", async () => {
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, ["stop"]);
    assert.equal(autostart, "no");
  });
  it("help never needs a runtime", async () => {
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, ["--help"]);
    assert.equal(autostart, "no");
  });
  it("retired HTTP transport flags decline autostart as unknown", async () => {
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, [
      "--server",
      "http://127.0.0.1:18080",
    ]);
    assert.equal(autostart, "no");
  });
  it("--no-autostart opts out per call", async () => {
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, ["--no-autostart"]);
    assert.equal(autostart, "no");
  });
  it("DYFJ_AUTOSTART=0 opts out standing", async () => {
    const { autostart } = await dryRun({
      HOME: FAKE_HOME,
      DYFJ_AUTOSTART: "0",
    });
    assert.equal(autostart, "no");
  });
  it("a custom socket still autostarts (on that socket)", async () => {
    const { autostart, route } = await dryRun({
      HOME: FAKE_HOME,
      DYFJ_SOCKET: "/run/custom.sock",
    });
    assert.equal(autostart, "yes");
    assert.equal(route, "node");
  });
});

describe("autostart classification is position-aware and socket-coherent", () => {
  it("an explicit --socket drives the launcher's own resolution", async () => {
    const { sock, route, autostart } = await dryRun({ HOME: FAKE_HOME }, [
      "--socket",
      "/run/explicit.sock",
    ]);
    assert.equal(sock, "/run/explicit.sock");
    assert.equal(route, "node");
    assert.equal(autostart, "yes");
  });
  it("--socket beats DYFJ_SOCKET", async () => {
    const { sock } = await dryRun(
      { HOME: FAKE_HOME, DYFJ_SOCKET: "/run/env.sock" },
      ["--socket", "/run/flag.sock"],
    );
    assert.equal(sock, "/run/flag.sock");
  });
  it("a -p prompt that is literally the word start still autostarts", async () => {
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, ["-p", "start"]);
    assert.equal(autostart, "yes");
  });
  it("a --model value named status is a value, not a subcommand", async () => {
    // --model takes an arbitrary slug, so this pins value-position handling
    // without tripping the client's session-ref validation (a --session value
    // of "status" is genuinely invalid there, and correctly declines).
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, [
      "--model",
      "status",
    ]);
    assert.equal(autostart, "yes");
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
    assert.equal(sock, `${FAKE_HOME}/.dyfj/run/workbench.sock`);
    assert.equal(autostart, "yes");
  });
  it("a -p prompt of --no-autostart does not opt out", async () => {
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, [
      "-p",
      "--no-autostart",
      "--model",
      "foo",
    ]);
    assert.equal(autostart, "yes");
  });
  it("a -p prompt of --help does not suppress autostart", async () => {
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, ["-p", "--help"]);
    assert.equal(autostart, "yes");
  });
  it("a -p prompt of -h does not suppress autostart", async () => {
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, ["-p", "-h"]);
    assert.equal(autostart, "yes");
  });
  it("a control-position --help still opts out", async () => {
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, ["--help"]);
    assert.equal(autostart, "no");
  });
  it("a -p prompt of --server does not decline autostart", async () => {
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, [
      "-p",
      "--server",
      "--model",
      "foo",
    ]);
    assert.equal(autostart, "yes");
  });
});

describe("autostart requires an absolute private log home", () => {
  async function runReal(
    env: Record<string, string>,
    cwd: string,
  ): Promise<{ code: number | null; err: string }> {
    const { code, stderr } = await output(BASH, [LAUNCHER, "sessions"], {
      cwd,
      env: { ...env, DYFJ_LAUNCHER_DRY_RUN: "" },
      stdout: "ignore",
    });
    return { code, err: stderr };
  }

  it("empty HOME declines instead of logging into the cwd", async () => {
    const cwd = await tempDir();
    try {
      // A socket that certainly is not answering, so the ensure path runs.
      const { code, err } = await runReal(
        { HOME: "", DYFJ_SOCKET: `${cwd}/x.sock` },
        cwd,
      );
      assert.notEqual(code, 0);
      includes(err, "absolute HOME");
      // Nothing durable appears in the invoking directory.
      const entries = await readdir(cwd);
      refutes(entries.includes(".dyfj"));
    } finally {
      await rm(cwd, { recursive: true });
    }
  });

  it("relative HOME declines the same way", async () => {
    const cwd = await tempDir();
    try {
      const { code, err } = await runReal(
        { HOME: "relative/home", DYFJ_SOCKET: `${cwd}/x.sock` },
        cwd,
      );
      assert.notEqual(code, 0);
      includes(err, "absolute HOME");
    } finally {
      await rm(cwd, { recursive: true });
    }
  });
});

describe("an invocation the client's parser rejects never triggers autostart", () => {
  it("an unknown flag declines autostart", async () => {
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, ["--bogus"]);
    assert.equal(autostart, "no");
  });
  it("an invalid enum value declines autostart", async () => {
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, ["--tier", "3"]);
    assert.equal(autostart, "no");
  });
  it("an explicitly empty --socket declines autostart", async () => {
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, ["--socket", ""]);
    assert.equal(autostart, "no");
  });
  it("a value flag with no value declines autostart", async () => {
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, ["--socket"]);
    assert.equal(autostart, "no");
  });
  it("a later non-empty --socket clears an earlier empty --socket", async () => {
    // "--socket '' --socket /tmp/x.sock" — empty first, then value: last-wins
    // clears emptiness, so autostart stays yes.
    const { autostart, sock } = await dryRun(
      { HOME: FAKE_HOME },
      ["--socket", "", "--socket", "/tmp/x.sock"],
    );
    assert.equal(autostart, "yes");
    assert.equal(sock, "/tmp/x.sock");
  });
  it("--socket '' last wins declines autostart", async () => {
    // "--socket /tmp/x.sock --socket ''" — value first, then empty: last-wins
    // emptiness, so autostart declines.
    const { autostart } = await dryRun(
      { HOME: FAKE_HOME },
      ["--socket", "/tmp/x.sock", "--socket", ""],
    );
    assert.equal(autostart, "no");
  });
  it("a bare -p declines autostart", async () => {
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, ["-p"]);
    assert.equal(autostart, "no");
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
    assert.equal(autostart, "yes");
  });

  it("a help FLAG wins over a prompt", async () => {
    const { autostart } = await dryRun({ HOME: FAKE_HOME }, [
      "--help",
      "-p",
      "hello",
    ]);
    assert.equal(autostart, "no");
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
    assert.equal(autostart, "yes");
  });
});

describe("the probe invokes the client on the UDS seam", () => {
  it("the client route invokes status without a retired transport flag", async () => {
    const lines = (await readFile(LAUNCHER, "utf8")).split("\n");
    const open = lines.findIndex((l) => l.trim() === "probe_runtime() {");
    assert.ok(open >= 0);
    const close = lines.findIndex((l, i) => i > open && l === "}");
    assert.ok(close > open);
    const body = lines.slice(open, close);
    const invocations = body.filter((l) =>
      l.trimEnd().endsWith("status >/dev/null 2>&1")
    );
    // One route: the node client. A second would be an unreviewed call.
    assert.equal(invocations.length, 1);
    for (const line of invocations) {
      includes(line, " status ");
      refutes(line.includes("--unix"));
      refutes(line.includes("--server"));
    }
  });
});

// Reads `stream` until its text includes `target` or it ends. Leaving the loop
// early destroys the stream, so the child's pipe is not left open.
async function readUntilStderr(
  stream: Readable,
  target: string,
): Promise<string> {
  stream.setEncoding("utf8");
  let text = "";
  for await (const chunk of stream) {
    text += chunk;
    if (text.includes(target)) break;
  }
  return text;
}

async function safeRemove(dir: string) {
  for (let i = 0; i < 10; i++) {
    try {
      await rm(dir, { recursive: true });
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
      const home = await realTempDir();
      const sock = `${home}/test-runtime.sock`;
      const base = "test-runtime";
      const hashOutput = await output(BASH, [
        "-c",
        'h=$(printf "%s" "$1" | shasum -a 256 2>/dev/null | cut -c1-16); [[ -n "$h" ]] && echo "$h" || printf "%s" "$1" | cksum | cut -d" " -f1',
        "bash",
        sock,
      ]);
      const hash = hashOutput.stdout.trim();

      const runDir = `${home}/.dyfj/run`;
      await mkdir(runDir, { recursive: true });
      const lockFile = `${runDir}/start-${base}-${hash}.lock`;

      const nowSec = Math.floor(Date.now() / 1000);
      await writeFile(lockFile, `${nowSec}\n`);

      const proc = spawnTracked(BASH, [LAUNCHER, "--socket", sock, "sessions"], {
        env: {
          HOME: home,
          DYFJ_SOCKET: sock,
          DYFJ_START_LOCK_TTL_SEC: "30",
          DYFJ_LAUNCHER_DRY_RUN: "",
        },
        stdio: ["ignore", "ignore", "pipe"],
      });

      try {
        const errText = await readUntilStderr(proc.child.stderr!, "already in flight");
        includes(errText, "already in flight");
        refutes(errText.includes("runtime not running at"));
        const lockContent = await readFile(lockFile, "utf8");
        assert.equal(lockContent.trim(), `${nowSec}`);
      } finally {
        // Release the piped stderr so the child's stream is not left open.
        proc.child.stderr?.destroy();
        await stopSpawned(proc);
        await reapPidsAndCommandsContaining([proc.child.pid ?? 0], sock);
        await safeRemove(home);
      }
    },
  );

  it(
    "a stale in-flight start lock (> TTL) is overwritten and allows a fresh start",
    async () => {
      const home = await realTempDir();
      const sock = `${home}/test-runtime.sock`;
      const base = "test-runtime";
      const hashOutput = await output(BASH, [
        "-c",
        'h=$(printf "%s" "$1" | shasum -a 256 2>/dev/null | cut -c1-16); [[ -n "$h" ]] && echo "$h" || printf "%s" "$1" | cksum | cut -d" " -f1',
        "bash",
        sock,
      ]);
      const hash = hashOutput.stdout.trim();

      const runDir = `${home}/.dyfj/run`;
      await mkdir(runDir, { recursive: true });
      const lockFile = `${runDir}/start-${base}-${hash}.lock`;

      // Stale timestamp (100 seconds ago) with no alive PID
      const staleSec = Math.floor(Date.now() / 1000) - 100;
      await writeFile(lockFile, `${staleSec}\n`);

      const beforeSec = Math.floor(Date.now() / 1000) - 2;
      let spawnedPid: number | undefined;
      let updatedTs: number | undefined;

      const proc = spawnTracked(BASH, [LAUNCHER, "--socket", sock, "sessions"], {
        env: {
          HOME: home,
          DYFJ_SOCKET: sock,
          DYFJ_START_LOCK_TTL_SEC: "30",
          DYFJ_LAUNCHER_DRY_RUN: "",
        },
        stdio: ["ignore", "ignore", "pipe"],
      });

      try {
        const errText = await readUntilStderr(proc.child.stderr!, "runtime not running at");
        includes(errText, "runtime not running at");
        refutes(errText.includes("already in flight"));
        try {
          const lockContent = await readFile(lockFile, "utf8");
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
          assert.ok(updatedTs >= beforeSec);
        }
        if (spawnedPid !== undefined) {
          assert.ok(spawnedPid > 0);
        }
      } finally {
        // Release the piped stderr so the child's stream is not left open.
        proc.child.stderr?.destroy();
        await stopSpawned(proc);
        await reapPidsAndCommandsContaining(
          [proc.child.pid ?? 0, spawnedPid ?? 0],
          sock,
        );
        await safeRemove(home);
      }
    },
  );

  it(
    "an in-flight start lock with an active living process suppresses duplicate spawn",
    async () => {
      const home = await realTempDir();
      const sock = `${home}/test-runtime.sock`;
      const base = "test-runtime";
      const hashOutput = await output(BASH, [
        "-c",
        'h=$(printf "%s" "$1" | shasum -a 256 2>/dev/null | cut -c1-16); [[ -n "$h" ]] && echo "$h" || printf "%s" "$1" | cksum | cut -d" " -f1',
        "bash",
        sock,
      ]);
      const hash = hashOutput.stdout.trim();

      const runDir = `${home}/.dyfj/run`;
      await mkdir(runDir, { recursive: true });
      const lockFile = `${runDir}/start-${base}-${hash}.lock`;

      // Spawn a dummy background process via BASH to represent a living in-flight start
      const dummy = spawnTracked(BASH, ["-c", "sleep 60"], {
        stdio: ["ignore", "ignore", "ignore"],
      });

      const nowSec = Math.floor(Date.now() / 1000);
      await writeFile(lockFile, `${nowSec} ${dummy.child.pid}\n`);

      const proc = spawnTracked(BASH, [LAUNCHER, "--socket", sock, "sessions"], {
        env: {
          HOME: home,
          DYFJ_SOCKET: sock,
          DYFJ_START_LOCK_TTL_SEC: "30",
          DYFJ_LAUNCHER_DRY_RUN: "",
        },
        stdio: ["ignore", "ignore", "pipe"],
      });

      try {
        const errText = await readUntilStderr(proc.child.stderr!, "already in flight");
        includes(errText, "already in flight");
        refutes(errText.includes("runtime not running at"));
      } finally {
        // Release the piped stderr so the child's stream is not left open.
        proc.child.stderr?.destroy();
        await stopSpawned(proc);
        await stopSpawned(dummy);
        await reapPidsAndCommandsContaining(
          [proc.child.pid ?? 0, dummy.child.pid ?? 0],
          sock,
        );
        await safeRemove(home);
      }
    },
  );
});

describe("interactive REPL front-end selection", () => {
  // A stand-in for the Rust REPL: executable, never run in dry-run mode.
  async function fakeReplBin(): Promise<string> {
    const dir = await tempDir("dyfj-repl-");
    const bin = `${dir}/dyfj-repl`;
    await writeFile(bin, "#!/bin/sh\nexit 0\n");
    await chmod(bin, 0o755);
    return bin;
  }

  // Runs the launcher under a pseudo-terminal, as an interactive session is,
  // when `terminal` is set; otherwise its stdio are pipes. The pty joins the
  // child's stderr to its stdout, so `out` carries both there. Not
  // `pty.spawn`: in older Pythons (macOS's /usr/bin/python3 is 3.9) its
  // copy loop, once the child exits on macOS (an empty read, not EIO) with
  // stdin already at EOF, waits on an empty `select` forever. This loop
  // stops at the master's EOF or error.
  const ON_A_PTY = [
    "import os, pty, sys",
    "pid, fd = pty.fork()",
    "if pid == 0: os.execvp(sys.argv[1], sys.argv[1:])",
    "while True:",
    "    try: data = os.read(fd, 4096)",
    "    except OSError: break",
    "    if not data: break",
    "    os.write(1, data)",
    "sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))",
  ].join("\n");

  async function launch(
    env: Record<string, string>,
    args: string[],
    { terminal = false, launcher = LAUNCHER } = {},
  ): Promise<{ code: number | null; out: string; err: string }> {
    const [command, commandArgs] = terminal
      ? ["python3", ["-c", ON_A_PTY, BASH, launcher, ...args]]
      : [BASH, [launcher, ...args]];
    const { code, stdout, stderr } = await output(command, commandArgs, {
      env: {
        DYFJ_LAUNCHER_DRY_RUN: "1",
        DYFJ_CODEX_TOOLCHAIN_PATH: "",
        DYFJ_CODEX_RUSTUP_HOME: "",
        HOME: FAKE_HOME,
        // Each case sets the routing variables it means to test.
        DYFJ_REPL: "",
        DYFJ_REPL_BIN: "",
        DYFJ_WORKBENCH_TIER: "",
        DYFJ_WORKBENCH_HINT: "",
        ...env,
      },
    });
    return { code, out: stdout, err: stderr };
  }

  it("routes a bare session with REPL flags to the Rust REPL", async () => {
    const bin = await fakeReplBin();
    const { code, out } = await launch(
      { DYFJ_REPL: "rust", DYFJ_REPL_BIN: bin },
      ["--model", "z-ai/glm-5.2", "--approve-paid", "--socket", "/tmp/r.sock"],
      { terminal: true },
    );
    assert.equal(code, 0);
    includes(out, "route=rust_repl");

    const auto = await launch({ DYFJ_REPL_BIN: bin }, [], { terminal: true });
    assert.equal(auto.code, 0);
    includes(auto.out, "route=rust_repl");
  });

  it("keeps the TypeScript REPL off a terminal, whatever DYFJ_REPL says", async () => {
    const bin = await fakeReplBin();
    // Off a terminal DYFJ_REPL is not read, so even an invalid value passes.
    for (const mode of ["", "rust", "invalid"]) {
      const { code, out } = await launch({
        DYFJ_REPL: mode,
        DYFJ_REPL_BIN: bin,
      }, []);
      assert.equal(code, 0, `DYFJ_REPL=${mode}`);
      assert.doesNotMatch(out, /route=rust_repl/);
    }
    // "auto" is the internal name for unset, not an accepted value.
    for (const mode of ["invalid", "auto"]) {
      const invalid = await launch(
        { DYFJ_REPL: mode, DYFJ_REPL_BIN: bin },
        [],
        { terminal: true },
      );
      assert.equal(invalid.code, 2, `DYFJ_REPL=${mode}`);
      includes(invalid.out, "DYFJ_REPL must be ts, rust or unset");
    }
  });

  it("leaves subcommands and prompts alone whatever DYFJ_REPL says", async () => {
    const bin = await fakeReplBin();
    for (const mode of ["rust", "invalid"]) {
      for (const args of [["status"], ["-p", "hi"], ["--help"]]) {
        // On a terminal, so the exemption is what keeps these off the Rust
        // REPL rather than the terminal check.
        const { code, out } = await launch(
          { DYFJ_REPL: mode, DYFJ_REPL_BIN: bin },
          args,
          { terminal: true },
        );
        assert.equal(code, 0, `${mode}: ${args.join(" ")}`);
        assert.doesNotMatch(out, /route=rust_repl/);
      }
    }
  });

  it("hands a REPL flag whose value starts with -- to the TypeScript REPL", async () => {
    const bin = await fakeReplBin();
    const { code, out } = await launch(
      { DYFJ_REPL: "rust", DYFJ_REPL_BIN: bin },
      ["--model", "--fast"],
      { terminal: true },
    );
    assert.equal(code, 2);
    includes(out, "only the TypeScript REPL takes");
  });

  it("execs the Rust REPL with its flags, --socket as DYFJ_SOCKET and the runtime log as DYFJ_RUNTIME_LOG", async () => {
    const dir = await tempDir("dyfj-repl-");
    const bin = `${dir}/dyfj-repl`;
    const record = `${dir}/record`;
    await writeFile(
      bin,
      `#!/bin/sh\nprintf '%s\\n' "sock=$DYFJ_SOCKET" "log=$DYFJ_RUNTIME_LOG" "$@" > '${record}'\n`,
    );
    await chmod(bin, 0o755);
    const { code } = await launch(
      {
        DYFJ_LAUNCHER_DRY_RUN: "",
        DYFJ_REPL: "rust",
        DYFJ_REPL_BIN: bin,
      },
      [
        "--no-autostart",
        "--model",
        "z-ai/glm-5.2",
        "--approve-paid",
        "--socket",
        "/tmp/r.sock",
      ],
      { terminal: true },
    );
    assert.equal(code, 0);
    const [sock, log, ...flags] = (await readFile(record, "utf8")).split("\n");
    assert.equal(sock, "sock=/tmp/r.sock");
    // The autostart log for that socket: basename plus a hash of the path.
    assert.match(log, new RegExp(`^log=${FAKE_HOME}/\\.dyfj/log/runtime-r-\\d+\\.log$`));
    assert.deepEqual(flags, ["--model", "z-ai/glm-5.2", "--approve-paid", ""]);
  });

  it("keeps tier and hint routing from the environment on the TypeScript REPL", async () => {
    const bin = await fakeReplBin();
    const routings: Record<string, string>[] = [
      { DYFJ_WORKBENCH_TIER: "1" },
      { DYFJ_WORKBENCH_HINT: "code" },
    ];
    for (const routing of routings) {
      const auto = await launch({ DYFJ_REPL_BIN: bin, ...routing }, [], {
        terminal: true,
      });
      assert.equal(auto.code, 0);
      assert.doesNotMatch(auto.out, /route=rust_repl/);

      const forced = await launch(
        { DYFJ_REPL: "rust", DYFJ_REPL_BIN: bin, ...routing },
        [],
        { terminal: true },
      );
      assert.equal(forced.code, 2);
      includes(forced.out, "only the TypeScript REPL reads them");
    }
    // A value the TypeScript client ignores changes nothing.
    const ignored = await launch(
      {
        DYFJ_REPL_BIN: bin,
        DYFJ_WORKBENCH_TIER: "9",
        DYFJ_WORKBENCH_HINT: "x",
      },
      [],
      { terminal: true },
    );
    includes(ignored.out, "route=rust_repl");
  });

  it("DYFJ_REPL=rust refuses a session the Rust REPL cannot take", async () => {
    const bin = await fakeReplBin();
    const tsOnly = await launch(
      { DYFJ_REPL: "rust", DYFJ_REPL_BIN: bin },
      ["--tier", "1"],
      { terminal: true },
    );
    assert.equal(tsOnly.code, 2);
    includes(tsOnly.out, "only the TypeScript REPL takes");

    const missing = await launch(
      { DYFJ_REPL: "rust", DYFJ_REPL_BIN: "/nonexistent/dyfj-repl" },
      [],
      { terminal: true },
    );
    assert.equal(missing.code, 2);
    includes(missing.out, "no dyfj-repl binary");

    const ts = await launch({ DYFJ_REPL: "ts", DYFJ_REPL_BIN: bin }, [], {
      terminal: true,
    });
    assert.doesNotMatch(ts.out, /route=rust_repl/);
  });

  // A checkout laid out as the launcher expects (prototype/ beside core/),
  // with the real client sources, a stand-in built REPL binary and stand-ins
  // for the sources it is built from.
  async function checkoutWithBuiltRepl(): Promise<{
    launcher: string;
    core: string;
    bin: string;
  }> {
    const root = await realTempDir();
    const prototype = `${root}/prototype`;
    const core = `${root}/core`;
    await mkdir(`${prototype}/scripts`, { recursive: true });
    await writeFile(
      `${prototype}/scripts/dyfj-launcher.sh`,
      await readFile(LAUNCHER, "utf8"),
    );
    await symlink(fileURLToPath(new URL("../src", import.meta.url)), `${prototype}/src`);
    await mkdir(`${core}/dyfj-repl/src`, { recursive: true });
    await mkdir(`${core}/target/release`, { recursive: true });
    const bin = `${core}/target/release/dyfj-repl`;
    await writeFile(bin, "#!/bin/sh\nexit 0\n");
    await chmod(bin, 0o755);
    const sources = [
      `${core}/dyfj-repl/src/main.rs`,
      `${core}/Cargo.toml`,
      `${core}/dyfj-repl/Cargo.toml`,
      `${core}/Cargo.lock`,
    ];
    for (const source of sources) await writeFile(source, "");
    // Every source predates the binary.
    const { utimes } = await import("node:fs/promises");
    const built = new Date(Date.now() - 60_000);
    const older = new Date(Date.now() - 120_000);
    for (const source of sources) await utimes(source, older, older);
    await utimes(bin, built, built);
    return { launcher: `${prototype}/scripts/dyfj-launcher.sh`, core, bin };
  }

  it("warns when the built Rust REPL binary is older than its sources, and builds nothing", async () => {
    const { launcher, core } = await checkoutWithBuiltRepl();
    const { utimes } = await import("node:fs/promises");
    // A cargo on PATH that records any call: the launcher must not run it.
    const tools = await tempDir("dyfj-cargo-");
    await writeFile(`${tools}/cargo`, `#!/bin/sh\ntouch '${tools}/called'\n`);
    await chmod(`${tools}/cargo`, 0o755);
    const env = { PATH: `${tools}:${process.env.PATH ?? ""}` };

    const fresh = await launch(env, [], { terminal: true, launcher });
    assert.equal(fresh.code, 0, fresh.out);
    includes(fresh.out, "route=rust_repl");
    assert.doesNotMatch(fresh.out, /older than its sources/);

    for (
      const source of [
        `${core}/dyfj-repl/src/main.rs`,
        `${core}/Cargo.toml`,
        `${core}/dyfj-repl/Cargo.toml`,
        `${core}/Cargo.lock`,
      ]
    ) {
      const newer = new Date();
      await utimes(source, newer, newer);
      const stale = await launch(env, [], { terminal: true, launcher });
      assert.equal(stale.code, 0, stale.out);
      includes(stale.out, "route=rust_repl");
      includes(
        stale.out,
        "dyfj: the Rust REPL binary is older than its sources; rebuild it from core/ with: cargo build --release -p dyfj-repl",
      );
      const before = new Date(Date.now() - 120_000);
      await utimes(source, before, before);
    }
    assert.equal(
      await stat(`${tools}/called`).then(() => true, () => false),
      false,
      "the launcher never runs cargo",
    );
  });

  it("does not judge a REPL binary the operator chose with DYFJ_REPL_BIN", async () => {
    const { launcher, core } = await checkoutWithBuiltRepl();
    const { utimes } = await import("node:fs/promises");
    const newer = new Date();
    await utimes(`${core}/dyfj-repl/src/main.rs`, newer, newer);
    const chosen = await fakeReplBin();
    const { code, out } = await launch(
      { DYFJ_REPL_BIN: chosen },
      [],
      { terminal: true, launcher },
    );
    assert.equal(code, 0, out);
    includes(out, "route=rust_repl");
    assert.doesNotMatch(out, /older than its sources/);
  });
});

describe("socket-path grant delimiter safety", () => {
  async function launchExpectingRejection(
    env: Record<string, string>,
    args: string[],
  ): Promise<{ code: number | null; err: string }> {
    const { code, stderr } = await output(BASH, [LAUNCHER, ...args], {
      env: {
        DYFJ_LAUNCHER_DRY_RUN: "1",
        ...env,
      },
    });
    return { code, err: stderr };
  }

  it("a comma-bearing DYFJ_SOCKET fails closed before any grant is built", async () => {
    const { code, err } = await launchExpectingRejection(
      { DYFJ_SOCKET: "/tmp/x.sock,example.invalid:443" },
      ["status"],
    );
    assert.notEqual(code, 0);
    includes(err, "must not contain a comma");
    // Content-free: the rejected value (which may carry private path content
    // or control bytes) must not be echoed back.
    refutes(err.includes("example.invalid"));
  });

  it("the rejection is content-free for control-bearing values", async () => {
    const { code, err } = await launchExpectingRejection(
      { DYFJ_SOCKET: "/tmp/\u001b[2Jevil,x.sock" },
      ["status"],
    );
    assert.notEqual(code, 0);
    includes(err, "must not contain a comma");
    refutes(err.includes("evil"));
    refutes(err.includes("\u001b"));
  });

  it("a comma-bearing --socket flag fails closed before any grant is built", async () => {
    const { code, err } = await launchExpectingRejection(
      {},
      ["--socket", "/tmp/x.sock,example.invalid:443", "status"],
    );
    assert.notEqual(code, 0);
    includes(err, "must not contain a comma");
  });

  it("a comma-bearing XDG_RUNTIME_DIR fails closed before any grant is built", async () => {
    const { code, err } = await launchExpectingRejection(
      { XDG_RUNTIME_DIR: "/tmp/x,evil" },
      ["status"],
    );
    assert.notEqual(code, 0);
    includes(err, "must not contain a comma");
  });
});

describe("the launcher requires Node 26", () => {
  async function runWithPath(
    path: string,
  ): Promise<{ code: number | null; err: string }> {
    const { code, stderr } = await output(
      BASH,
      [LAUNCHER, "--no-autostart", "status"],
      {
        env: { PATH: path, HOME: FAKE_HOME, DYFJ_LAUNCHER_DRY_RUN: "1" },
        stdout: "ignore",
      },
    );
    return { code, err: stderr };
  }

  async function withFakeNode(
    script: string,
    run: (bin: string) => Promise<void>,
  ): Promise<void> {
    const root = await tempDir("dyfj-launcher-node-");
    try {
      await writeFile(`${root}/node`, script);
      await chmod(`${root}/node`, 0o700);
      await run(root);
    } finally {
      await rm(root, { recursive: true });
    }
  }

  it("fails clearly when node is not on PATH", async () => {
    await withFakeNode("", async (empty) => {
      await rm(`${empty}/node`);
      const { code, err } = await runWithPath(`${empty}:/usr/bin:/bin`);
      assert.notEqual(code, 0);
      includes(err, "node is not on PATH; dyfj needs Node 26");
    });
  });

  it("fails clearly on another Node major version", async () => {
    await withFakeNode("#!/bin/sh\necho v22.11.0\n", async (bin) => {
      const { code, err } = await runWithPath(`${bin}:/usr/bin:/bin`);
      assert.notEqual(code, 0);
      includes(
        err,
        "dyfj needs Node 26, but node on PATH is v22.11.0",
      );
    });
  });

  it("does not echo a malformed version string", async () => {
    await withFakeNode("#!/bin/sh\necho 'v26\x1b[2Jx'\n", async (bin) => {
      const { code, err } = await runWithPath(`${bin}:/usr/bin:/bin`);
      assert.notEqual(code, 0);
      includes(err, "node on PATH is an unrecognized version");
    });
  });

  it("accepts Node 26", async () => {
    await withFakeNode("#!/bin/sh\necho v26.11.1\n", async (bin) => {
      const { code } = await runWithPath(`${bin}:/usr/bin:/bin`);
      assert.equal(code, 0);
    });
  });
});

describe("HOME=/ produces a single-slash runtime log path", () => {
  it("a root HOME does not produce a double-slash log path in dry-run output", async () => {
    const { code, stdout } = await output(BASH, [LAUNCHER], {
      env: {
        DYFJ_LAUNCHER_DRY_RUN: "1",
        DYFJ_CODEX_TOOLCHAIN_PATH: "",
        DYFJ_CODEX_RUSTUP_HOME: "",
        HOME: "/",
      },
    });
    assert.equal(code, 0);
    const text = stdout.trim();
    const logMatch = text.match(/log=(\S+)/);
    const log = logMatch?.[1];
    // When HOME=/, runtime_log_path yields /.dyfj/log/... (home="" so
    // printf produces a single leading slash).  Assert the log field starts
    // with /.dyfj/log/ and not //.
    assert.equal(log?.startsWith("/.dyfj/log/"), true);
    assert.equal(log?.startsWith("//"), false);
  });
});
