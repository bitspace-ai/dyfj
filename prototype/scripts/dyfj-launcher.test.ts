import { describe, expect, test } from "vitest";

const LAUNCHER = new URL("./dyfj-launcher.sh", import.meta.url).pathname;
const COMPILED_BIN = new URL("../dist/dyfj-bin", import.meta.url).pathname;

async function hasCompiledBin(): Promise<boolean> {
  return await Deno.stat(COMPILED_BIN).then(() => true).catch(() => false);
}

async function dryRun(
  env: Record<string, string>,
  args: string[] = [],
): Promise<{ route: string; sock: string }> {
  const proc = new Deno.Command("bash", {
    args: [LAUNCHER, ...args],
    env: { ...Deno.env.toObject(), DYFJ_LAUNCHER_DRY_RUN: "1", ...env },
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
  if (!route || !sock) {
    throw new Error(`unexpected dry-run output: ${text}`);
  }
  return { route, sock };
}

describe("dyfj launcher routing", () => {
  test("default path prefers compiled when the binary exists", async () => {
    const { route, sock } = await dryRun({ HOME: "/home/c" });
    expect(sock).toBe("/home/c/.dyfj/run/workbench.sock");
    if (await hasCompiledBin()) {
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
    if (await hasCompiledBin()) {
      expect(route).toBe("compiled");
    } else {
      expect(route).toBe("deno");
    }
  });

  test("HTTP transport does not force deno when a compiled binary is present", async () => {
    if (!(await hasCompiledBin())) return;

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
