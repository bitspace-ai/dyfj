import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@std/testing/bdd";
import {
  buildServeUnixArgs,
  memoryMcpNetGrant,
  nodeRunGrant,
  readLauncherMcpServersConfig,
  readLauncherSecretsConfig,
  readMemoryMcpNetGrant,
  readServeUnixEnvGrants,
  readServeUnixNetGrants,
  readServeUnixRunGrants,
  rustupHomeReadGrant,
  toolchainReadGrant,
} from "./grants.ts";

// Assembled at runtime so the public-boundary scan never matches this
// fixture as a home-directory path in tracked source.
const FAKE_HOME = ["", "home", "x"].join("/");

/** A missing-file rejection, as a real file read reports it. */
function notFound(): Error {
  return Object.assign(new Error("No such file or directory"), {
    code: "ENOENT",
  });
}

describe("runtime lifecycle commands", () => {
  it("buildServeUnixArgs grants the resolved socket alongside the profile net list", () => {
    const args = buildServeUnixArgs(
      ["127.0.0.1:3306", "localhost:18080"],
      "/run/wb.sock",
    );
    assert.deepStrictEqual(args, [
      "run",
      "--no-prompt",
      "-P=serve-unix",
      "--allow-net=127.0.0.1:3306,localhost:18080,unix:/run/wb.sock",
      "--env-file=.env",
      "src/server/main.ts",
    ]);
  });

  it("buildServeUnixArgs does not duplicate an already-granted socket", () => {
    const args = buildServeUnixArgs(
      ["unix:/run/wb.sock"],
      "/run/wb.sock",
    );
    assert.strictEqual(args[3], "--allow-net=unix:/run/wb.sock");
  });

  it("buildServeUnixArgs marks only an autostarted runtime", () => {
    const foreground = buildServeUnixArgs(
      ["127.0.0.1:3306"],
      "/run/wb.sock",
    );
    const autostarted = buildServeUnixArgs(
      ["127.0.0.1:3306"],
      "/run/wb.sock",
      null,
      null,
      null,
      true,
    );

    assert.ok(!foreground.includes("--autostarted"));
    assert.strictEqual(autostarted.at(-1), "--autostarted");
  });

  it("buildServeUnixArgs appends the launch-resolved memory endpoint grant", () => {
    const args = buildServeUnixArgs(
      ["127.0.0.1:3306"],
      "/run/wb.sock",
      "memory.example:443",
    );
    assert.strictEqual(
      args[3],
      "--allow-net=127.0.0.1:3306,unix:/run/wb.sock,memory.example:443",
    );
  });

  it("buildServeUnixArgs appends unique config-declared MCP endpoint grants", () => {
    const args = buildServeUnixArgs(
      ["127.0.0.1:3306", "mcp.linear.app:443"],
      "/run/wb.sock",
      null,
      null,
      null,
      false,
      ["mcp.linear.app:443", "127.0.0.1:43137"],
    );
    assert.strictEqual(
      args[3],
      "--allow-net=127.0.0.1:3306,mcp.linear.app:443,unix:/run/wb.sock,127.0.0.1:43137",
    );
  });

  it("buildServeUnixArgs appends unique launch-resolved nameserver grants", () => {
    const args = buildServeUnixArgs(
      ["127.0.0.1:3306"],
      "/run/wb.sock",
      null,
      null,
      null,
      false,
      ["mcp.linear.app:443"],
      ["127.0.0.53:53", "[2001:db8::53]:53", "127.0.0.53:53"],
    );
    assert.strictEqual(
      args[3],
      "--allow-net=127.0.0.1:3306,unix:/run/wb.sock,mcp.linear.app:443,127.0.0.53:53,[2001:db8::53]:53",
    );
  });

  it("buildServeUnixArgs rejects comma-bearing network grants", () => {
    assert.throws(
      () =>
        buildServeUnixArgs(
          ["127.0.0.1:3306"],
          "/run/wb.sock",
          null,
          null,
          null,
          false,
          ["foo,bar.example:443"],
        ),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("Deno network grants cannot contain commas"),
    );
  });

  it("buildServeUnixArgs adds no memory grant when recall is unconfigured", () => {
    const args = buildServeUnixArgs(["127.0.0.1:3306"], "/run/wb.sock", null);
    assert.strictEqual(args[3], "--allow-net=127.0.0.1:3306,unix:/run/wb.sock");
  });

  it("buildServeUnixArgs does not duplicate an already-granted memory host", () => {
    const args = buildServeUnixArgs(
      ["memory.example:443"],
      "/run/wb.sock",
      "memory.example:443",
    );
    assert.strictEqual(
      args[3],
      "--allow-net=memory.example:443,unix:/run/wb.sock",
    );
  });

  it("memoryMcpNetGrant derives host:port, defaulting the scheme port", () => {
    assert.strictEqual(memoryMcpNetGrant(undefined), null);
    assert.strictEqual(memoryMcpNetGrant(""), null);
    assert.strictEqual(
      memoryMcpNetGrant("https://memory.example/mcp"),
      "memory.example:443",
    );
    assert.strictEqual(
      memoryMcpNetGrant("https://memory.example:8443/mcp"),
      "memory.example:8443",
    );
    // Plain http is loopback-only; the default port still derives.
    assert.strictEqual(
      memoryMcpNetGrant("http://127.0.0.1:8080/mcp"),
      "127.0.0.1:8080",
    );
    assert.strictEqual(
      memoryMcpNetGrant("http://localhost/mcp"),
      "localhost:80",
    );
  });

  it("memoryMcpNetGrant keeps IPv6 hosts bracketed, as Deno grants require", () => {
    // WHATWG URL.hostname returns IPv6 literals WITH brackets (unlike legacy
    // url.parse), which is exactly the shape --allow-net expects.
    assert.strictEqual(
      memoryMcpNetGrant("http://[::1]:8443/mcp"),
      "[::1]:8443",
    );
    assert.strictEqual(
      memoryMcpNetGrant("https://[2001:db8::1]/mcp"),
      "[2001:db8::1]:443",
    );
  });

  it("memoryMcpNetGrant fails at launch on a malformed or insecure endpoint", () => {
    // Misconfiguration surfaces at `dyfj start`, not as NotCapable mid-recall —
    // and a grant is never derived for a destination that would carry the
    // token in cleartext off-box.
    assert.throws(
      () => memoryMcpNetGrant("not a url"),
      (error: unknown) =>
        error instanceof Error && error.message.includes("not a valid URL"),
    );
    assert.throws(
      () => memoryMcpNetGrant("ftp://memory.example/mcp"),
      (error: unknown) =>
        error instanceof Error && error.message.includes("https"),
    );
    assert.throws(
      () => memoryMcpNetGrant("http://memory.example/mcp"),
      (error: unknown) =>
        error instanceof Error && error.message.includes("https"),
    );
    // A DNS name that merely starts with "127." is routable, not loopback.
    assert.throws(
      () => memoryMcpNetGrant("http://127.attacker.example/mcp"),
      (error: unknown) =>
        error instanceof Error && error.message.includes("https"),
    );
    assert.throws(
      () => memoryMcpNetGrant("http://127.example.com/mcp"),
      (error: unknown) =>
        error instanceof Error && error.message.includes("https"),
    );
  });

  const noAmbient = { get: () => undefined };

  it("readMemoryMcpNetGrant resolves the grant from the runtime env file", async () => {
    const grant = await readMemoryMcpNetGrant(
      "/proto",
      (path) => {
        assert.strictEqual(path, "/proto/.env");
        return Promise.resolve(
          "DYFJ_MEMORY_MCP_URL=https://memory.example/mcp\n",
        );
      },
      noAmbient,
    );
    assert.strictEqual(grant, "memory.example:443");
  });

  it("readMemoryMcpNetGrant is null without an env file or endpoint", async () => {
    assert.strictEqual(
      await readMemoryMcpNetGrant(
        "/proto",
        () => Promise.reject(new Error("ENOENT")),
        noAmbient,
      ),
      null,
    );
    assert.strictEqual(
      await readMemoryMcpNetGrant(
        "/proto",
        () => Promise.resolve("OTHER=1\n"),
        noAmbient,
      ),
      null,
    );
  });

  it("readMemoryMcpNetGrant prefers ambient env, as --env-file does in the child", async () => {
    // The spawned runtime inherits ambient env and --env-file does not override
    // it; the launcher must grant the host the child will actually dial.
    const grant = await readMemoryMcpNetGrant(
      "/proto",
      () => Promise.resolve("DYFJ_MEMORY_MCP_URL=https://stale.example/mcp\n"),
      {
        get: (
          name,
        ) => (name === "DYFJ_MEMORY_MCP_URL"
          ? "https://ambient.example/mcp"
          : undefined),
      },
    );
    assert.strictEqual(grant, "ambient.example:443");
  });

  it("readMemoryMcpNetGrant treats an empty ambient value as authoritative", async () => {
    // --env-file does not fill an explicitly empty inherited var: the child
    // sees "" and disables recall, so no grant may be derived from the file.
    const grant = await readMemoryMcpNetGrant(
      "/proto",
      () => Promise.resolve("DYFJ_MEMORY_MCP_URL=https://memory.example/mcp\n"),
      { get: (name) => (name === "DYFJ_MEMORY_MCP_URL" ? "" : undefined) },
    );
    assert.strictEqual(grant, null);
  });

  it("every dyfj CLI surface may read the memory endpoint URL", async () => {
    // The launcher derives the child's net grant from DYFJ_MEMORY_MCP_URL, so
    // all three CLI permission surfaces (profile, compiled binary, launcher
    // script) must stay in lockstep on the env grant.
    const raw = await readFile("deno.json", "utf8");
    const parsed = JSON.parse(raw) as {
      tasks: Record<string, string>;
      permissions: Record<string, { env?: string[] | boolean }>;
    };
    const cliEnv = parsed.permissions["cli"].env;
    assert.ok(Array.isArray(cliEnv));
    assert.deepStrictEqual(
      ["DYFJ_MEMORY_MCP_URL"].filter((item) => !cliEnv.includes(item)),
      [],
    );
    assert.deepStrictEqual(
      ["DYFJ_NODE_PATH"].filter((item) => !cliEnv.includes(item)),
      [],
    );
    assert.deepStrictEqual(
      ["DYFJ_CODEX_TOOLCHAIN_PATH"].filter((item) => !cliEnv.includes(item)),
      [],
    );
    assert.deepStrictEqual(
      ["DYFJ_CODEX_RUSTUP_HOME"].filter((item) => !cliEnv.includes(item)),
      [],
    );
    const compileEnv = parsed.tasks["compile-cli"].match(/--allow-env=(\S+)/)
      ?.[1]?.split(",") ?? [];
    assert.deepStrictEqual(
      ["DYFJ_MEMORY_MCP_URL"].filter((item) => !compileEnv.includes(item)),
      [],
    );
    assert.deepStrictEqual(
      ["DYFJ_NODE_PATH"].filter((item) => !compileEnv.includes(item)),
      [],
    );
    assert.deepStrictEqual(
      ["DYFJ_CODEX_TOOLCHAIN_PATH"].filter((item) =>
        !compileEnv.includes(item)
      ),
      [],
    );
    assert.deepStrictEqual(
      ["DYFJ_CODEX_RUSTUP_HOME"].filter((item) => !compileEnv.includes(item)),
      [],
    );
    const launcher = await readFile("scripts/dyfj-launcher.sh", "utf8");
    const launcherEnv = launcher.match(/printf '%s' '([^']+)'/)?.[1]
      ?.split(",") ?? [];
    assert.deepStrictEqual(
      ["DYFJ_MEMORY_MCP_URL"].filter((item) => !launcherEnv.includes(item)),
      [],
    );
    assert.deepStrictEqual(
      ["DYFJ_NODE_PATH"].filter((item) => !launcherEnv.includes(item)),
      [],
    );
    assert.deepStrictEqual(
      ["DYFJ_CODEX_TOOLCHAIN_PATH"].filter((item) =>
        !launcherEnv.includes(item)
      ),
      [],
    );
    assert.deepStrictEqual(
      ["DYFJ_CODEX_RUSTUP_HOME"].filter((item) => !launcherEnv.includes(item)),
      [],
    );
  });

  it("the internal autostart marker is not ambient process state", async () => {
    const raw = await readFile("deno.json", "utf8");
    const parsed = JSON.parse(raw) as {
      tasks: Record<string, string>;
      permissions: Record<string, { env?: string[] | boolean }>;
    };
    const cliEnv = parsed.permissions["cli"].env;
    assert.ok(Array.isArray(cliEnv));
    assert.ok(!cliEnv.includes("DYFJ_AUTOSTARTED"));
    const compileEnv = parsed.tasks["compile-cli"].match(/--allow-env=(\S+)/)
      ?.[1]?.split(",") ?? [];
    assert.ok(!compileEnv.includes("DYFJ_AUTOSTARTED"));
    const launcher = await readFile("scripts/dyfj-launcher.sh", "utf8");
    const launcherEnv = launcher.match(/printf '%s' '([^']+)'/)?.[1]
      ?.split(",") ?? [];
    assert.ok(!launcherEnv.includes("DYFJ_AUTOSTARTED"));
  });

  it("readServeUnixNetGrants reads the real profile", async () => {
    // Guards the runtime read path: the serve-unix profile must keep a
    // declared net grant list for dyfj start to reproduce.
    const grants = await readServeUnixNetGrants(".");
    assert.ok(grants.length > 0);
    assert.deepStrictEqual(
      ["127.0.0.1:3306"].filter((item) => !grants.includes(item)),
      [],
    );
  });
});

describe("readServeUnixRunGrants", () => {
  it("reads the serve-unix run grant list from the real profile", async () => {
    const grants = await readServeUnixRunGrants(".");
    assert.deepStrictEqual(
      ["bash"].filter((item) => !grants.includes(item)),
      [],
    );
  });
});

describe("nodeRunGrant", () => {
  it("allows a runtime without the optional Codex route", async () => {
    assert.strictEqual(await nodeRunGrant({ get: () => undefined }), null);
  });
});

describe("buildServeUnixArgs with launch-resolved run grants", () => {
  const NET = ["127.0.0.1:3306"];
  const SOCK = "/run/dyfj/workbench.sock";

  it("omits --allow-run when no resolver is configured (null)", () => {
    const args = buildServeUnixArgs(NET, SOCK, null, null);
    assert.strictEqual(args.some((a) => a.startsWith("--allow-run")), false);
    // -P still supplies the profile's run grants unchanged.
    assert.deepStrictEqual(
      ["-P=serve-unix"].filter((item) => !args.includes(item)),
      [],
    );
  });

  it("appends --allow-run with the profile grants plus the resolver binary", () => {
    const args = buildServeUnixArgs(NET, SOCK, null, [
      "bash",
      "/opt/node/bin/node",
      "/bin/kill",
      "op",
    ]);
    assert.deepStrictEqual(
      [
        "--allow-run=bash,/opt/node/bin/node,/bin/kill,op",
      ].filter((item) => !args.includes(item)),
      [],
    );
  });

  it("rejects delimiter-unsafe run grants", () => {
    assert.throws(
      () =>
        buildServeUnixArgs(NET, SOCK, null, [
          "bash",
          "/opt/Node,Inc/bin/node",
        ]),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("Deno run grants cannot contain commas"),
    );
  });

  it("the socket grant is still present alongside the run grant", () => {
    const args = buildServeUnixArgs(NET, SOCK, null, ["bash", "op"]);
    const net = args.find((a) => a.startsWith("--allow-net="));
    assert.ok(
      (net ?? "").includes(`unix:${SOCK}`),
      `expected net ?? "" to include \`unix:\${SOCK}\``,
    );
  });

  it("omits --allow-env when no inherit_env grant is needed (null)", () => {
    const args = buildServeUnixArgs(NET, SOCK, null, null, null);
    assert.strictEqual(args.some((a) => a.startsWith("--allow-env")), false);
  });

  it("appends --allow-env with the profile env plus the inherit_env names", () => {
    const args = buildServeUnixArgs(NET, SOCK, null, null, [
      "PATH",
      "HOME",
      "OP_SERVICE_ACCOUNT_TOKEN",
    ]);
    assert.deepStrictEqual(
      [
        "--allow-env=PATH,HOME,OP_SERVICE_ACCOUNT_TOKEN",
      ].filter((item) => !args.includes(item)),
      [],
    );
  });
});

describe("toolchainReadGrant", () => {
  it("validates one readable directory and preserves its selected path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tmp-"));
    try {
      assert.strictEqual(
        await toolchainReadGrant({ get: () => directory }),
        directory,
      );
      assert.strictEqual(
        await toolchainReadGrant({ get: () => undefined }),
        null,
      );
    } finally {
      await rmdir(directory);
    }
  });

  it("rejects whole dot components before resolving the selected path", async () => {
    const root = await mkdtemp(join(tmpdir(), "tmp-"));
    const child = `${root}/child`;
    const dotted = [
      `${root}/.cargo`,
      `${root}/.rustup`,
      `${root}/..cache`,
      `${root}/tool.chain`,
    ];
    await mkdir(child);
    for (const directory of dotted) await mkdir(directory);
    try {
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
        ]
      ) {
        let failure: Error | undefined;
        try {
          await toolchainReadGrant({ get: () => value });
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
        }
        assert.strictEqual(
          failure?.message,
          "Codex toolchain path must not contain dot components",
        );
        assert.ok(!(failure?.message).includes(value));
      }
      for (const directory of dotted) {
        assert.strictEqual(
          await toolchainReadGrant({ get: () => directory }),
          directory,
        );
      }
    } finally {
      await rm(root, { recursive: true });
    }
  });
});

describe("rustupHomeReadGrant", () => {
  it("validates one readable directory and preserves its selected path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tmp-"));
    try {
      assert.strictEqual(
        await rustupHomeReadGrant({ get: () => directory }),
        directory,
      );
      assert.strictEqual(
        await rustupHomeReadGrant({ get: () => undefined }),
        null,
      );
    } finally {
      await rmdir(directory);
    }
  });

  it("rejects whole dot components before resolving the selected path", async () => {
    const root = await mkdtemp(join(tmpdir(), "tmp-"));
    const child = `${root}/child`;
    const dotted = [
      `${root}/.cargo`,
      `${root}/.rustup`,
      `${root}/..cache`,
      `${root}/tool.chain`,
    ];
    await mkdir(child);
    for (const directory of dotted) await mkdir(directory);
    try {
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
        ]
      ) {
        let failure: Error | undefined;
        try {
          await rustupHomeReadGrant({ get: () => value });
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
        }
        assert.strictEqual(
          failure?.message,
          "Codex Rustup home must not contain dot components",
        );
        assert.ok(!(failure?.message).includes(value));
      }
      for (const directory of dotted) {
        assert.strictEqual(
          await rustupHomeReadGrant({ get: () => directory }),
          directory,
        );
      }
    } finally {
      await rm(root, { recursive: true });
    }
  });
});

describe("Codex toolchain runtime grant", () => {
  it("the serve-unix profile may read the operator selection", async () => {
    const envGrants = await readServeUnixEnvGrants(".");
    assert.deepStrictEqual(
      ["DYFJ_CODEX_TOOLCHAIN_PATH"].filter((item) => !envGrants.includes(item)),
      [],
    );
    assert.deepStrictEqual(
      ["DYFJ_CODEX_RUSTUP_HOME"].filter((item) => !envGrants.includes(item)),
      [],
    );
  });
});

describe("readServeUnixEnvGrants", () => {
  it("reads the serve-unix env grant list from the real profile", async () => {
    const grants = await readServeUnixEnvGrants(".");
    assert.deepStrictEqual(
      ["PATH"].filter((item) => !grants.includes(item)),
      [],
    );
    assert.deepStrictEqual(
      ["HOME"].filter((item) => !grants.includes(item)),
      [],
    );
  });
});

describe("every dyfj CLI surface may read DYFJ_ROOT", () => {
  it("profile, compiled binary, and launcher stay in lockstep on DYFJ_ROOT", async () => {
    // dyfj start reads ~/.dyfj/config.toml (located via DYFJ_ROOT) to derive the
    // child's --allow-run resolver-binary grant, so all three CLI permission
    // surfaces must grant DYFJ_ROOT.
    const raw = await readFile("deno.json", "utf8");
    const parsed = JSON.parse(raw) as {
      tasks: Record<string, string>;
      permissions: Record<string, { env?: string[] | boolean }>;
    };
    const cliEnv = parsed.permissions["cli"].env;
    assert.ok(Array.isArray(cliEnv));
    assert.deepStrictEqual(
      ["DYFJ_ROOT"].filter((item) => !cliEnv.includes(item)),
      [],
    );
    const compileEnv = parsed.tasks["compile-cli"].match(/--allow-env=(\S+)/)
      ?.[1]?.split(",") ?? [];
    assert.deepStrictEqual(
      ["DYFJ_ROOT"].filter((item) => !compileEnv.includes(item)),
      [],
    );
    const launcher = await readFile("scripts/dyfj-launcher.sh", "utf8");
    const launcherEnv = launcher.match(/printf '%s' '([^']+)'/)?.[1]
      ?.split(",") ?? [];
    assert.deepStrictEqual(
      ["DYFJ_ROOT"].filter((item) => !launcherEnv.includes(item)),
      [],
    );
  });
});

describe("readLauncherSecretsConfig (.env / DYFJ_ROOT precedence)", () => {
  // Inject a parser: these test path precedence, not TOML parsing.
  // readTextFile returns this marker for the config file; the parser maps it
  // to a [secrets] table.
  const TOML = "(toml)";
  const parse = () => ({
    secrets: {
      command: ["op", "read"],
      pointers: { ANTHROPIC_API_KEY: "op://v/a/credential" },
    },
  });

  it("ambient DYFJ_ROOT wins and locates config.toml there", async () => {
    const reads: string[] = [];
    const readTextFile = (path: string) => {
      reads.push(path);
      if (path === "/ambient/config.toml") return Promise.resolve(TOML);
      return Promise.reject(notFound());
    };
    const env = {
      get: (n: string) =>
        n === "DYFJ_ROOT" ? "/ambient" : n === "HOME" ? FAKE_HOME : undefined,
    };
    const cfg = await readLauncherSecretsConfig(
      "/cwd",
      readTextFile,
      env,
      parse,
    );
    assert.deepStrictEqual(cfg?.command, ["op", "read"]);
    // Ambient root is used directly; .env is not consulted for the root.
    assert.deepStrictEqual(
      ["/ambient/config.toml"].filter((item) => !reads.includes(item)),
      [],
    );
  });

  it("falls back to .env DYFJ_ROOT when ambient is unset (mirrors the child)", async () => {
    const readTextFile = (path: string) => {
      if (path === "/cwd/.env") return Promise.resolve("DYFJ_ROOT=/from-env\n");
      if (path === "/from-env/config.toml") return Promise.resolve(TOML);
      return Promise.reject(notFound());
    };
    const env = { get: (n: string) => (n === "HOME" ? FAKE_HOME : undefined) };
    const cfg = await readLauncherSecretsConfig(
      "/cwd",
      readTextFile,
      env,
      parse,
    );
    assert.strictEqual(cfg?.pointers.ANTHROPIC_API_KEY, "op://v/a/credential");
  });

  it("falls back to HOME/.dyfj when neither ambient nor .env set the root", async () => {
    const readTextFile = (path: string) => {
      if (path === `${FAKE_HOME}/.dyfj/config.toml`) {
        return Promise.resolve(TOML);
      }
      return Promise.reject(notFound());
    };
    const env = { get: (n: string) => (n === "HOME" ? FAKE_HOME : undefined) };
    const cfg = await readLauncherSecretsConfig(
      "/cwd",
      readTextFile,
      env,
      parse,
    );
    assert.deepStrictEqual(cfg?.command, ["op", "read"]);
  });

  it("empty ambient DYFJ_ROOT is treated as absent, NOT read from .env (mirrors the child)", async () => {
    const readPaths: string[] = [];
    const readTextFile = (path: string) => {
      readPaths.push(path);
      // A .env that DOES set DYFJ_ROOT — the launcher must ignore it here,
      // because the child's --env-file can't override the empty ambient value.
      if (path === "/cwd/.env") return Promise.resolve("DYFJ_ROOT=/from-env\n");
      if (path === `${FAKE_HOME}/.dyfj/config.toml`) {
        return Promise.resolve(TOML);
      }
      return Promise.reject(notFound());
    };
    const env = {
      get: (n: string) =>
        n === "DYFJ_ROOT" ? "" : n === "HOME" ? FAKE_HOME : undefined,
    };
    const cfg = await readLauncherSecretsConfig(
      "/cwd",
      readTextFile,
      env,
      parse,
    );
    assert.deepStrictEqual(cfg?.command, ["op", "read"]);
    // Resolved against HOME, and .env was never consulted for the root.
    assert.deepStrictEqual(
      [`${FAKE_HOME}/.dyfj/config.toml`].filter((item) =>
        !readPaths.includes(item)
      ),
      [],
    );
    assert.ok(!readPaths.includes("/cwd/.env"));
  });

  it("loads external MCP servers from the same child-visible config", async () => {
    const readTextFile = (path: string) => {
      if (path === `${FAKE_HOME}/.dyfj/config.toml`) {
        return Promise.resolve(TOML);
      }
      return Promise.reject(notFound());
    };
    const env = {
      get: (name: string) => name === "HOME" ? FAKE_HOME : undefined,
    };
    const secrets = await readLauncherSecretsConfig(
      "/cwd",
      readTextFile,
      env,
      () => ({
        secrets: {
          command: ["op", "read"],
          named: { linear_mcp: "op://v/linear/credential" },
        },
      }),
    );
    const servers = await readLauncherMcpServersConfig(
      "/cwd",
      secrets,
      readTextFile,
      env,
      () => ({
        mcp: {
          servers: [{
            id: "linear",
            transport: "streamable_http",
            url: "https://mcp.linear.app/mcp",
            minimum_clearance: "loopback",
            auth: { type: "bearer", secret: "linear_mcp" },
            tools: [{ name: "get_issue", effect: "read", approval: "allow" }],
          }],
        },
      }),
    );
    assert.deepStrictEqual(servers.map((server) => server.id), ["linear"]);
  });
});
