import { afterEach, describe, expect, test } from "vitest";
import {
  type CliConfig,
  formatRuntimeStatus,
  type Io,
  parseArgs,
  runStop,
} from "./cli";
import { serveWorkbenchUnix, type WorkbenchUnixServer } from "./uds-server";
import { type UnixClient } from "./uds-client";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function fakeIo(): { io: Io; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const raw: string[] = [];
  return {
    io: {
      out: (s) => stdout.push(s),
      err: (s) => stderr.push(s),
      errRaw: (s) => raw.push(s),
      readLine: () => Promise.resolve(null),
      close: () => {},
    },
    stdout,
    stderr,
  };
}

function cfg(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    serverUrl: "http://localhost:8787",
    socket: "/tmp/fake-wb.sock",
    mode: "turn",
    color: false,
    ...overrides,
  };
}

describe("parseArgs for stop subcommand", () => {
  test("parses bare stop command", () => {
    const parsed = parseArgs(["stop"]);
    expect(parsed).toEqual({
      command: "stop",
      json: false,
      overrides: {},
    });
  });

  test("parses stop with custom socket path", () => {
    const parsed = parseArgs(["stop", "--socket", "/custom/path.sock"]);
    expect(parsed).toEqual({
      command: "stop",
      json: false,
      overrides: { socket: "/custom/path.sock" },
    });
  });

  test("rejects stop with positional prompt argument", () => {
    const parsed = parseArgs(["stop", "prompt"]);
    expect(parsed.command).toBe("help");
    expect(parsed.error).toContain("unknown command: stop");
  });

  test("rejects --launcher-autostarted on stop", () => {
    const parsed = parseArgs(["--launcher-autostarted", "stop"]);
    expect(parsed.command).toBe("help");
    expect(parsed.error).toContain(
      "--launcher-autostarted is valid only with start",
    );
  });
});

describe("formatRuntimeStatus mode annotations", () => {
  test("annotates background autostarted mode when autostarted is true", () => {
    const text = formatRuntimeStatus(cfg({ socket: "/run/wb.sock" }), {
      runtime: {
        transport: "uds",
        clearance: "loopback",
        defaultCompanionModel: "qwen-local",
        permissionLevel: "strict",
        approvePaidDefault: false,
        defaultSessionBudgetUsd: 2,
        defaultPerCallBudgetUsd: 0.25,
        maxToolSteps: 7,
        models: { total: 3, local: 1, hosted: 2 },
        methods: ["runtime/status", "models/list"],
        autostarted: true,
      },
    });
    expect(text).toContain("mode: background (autostarted)");
  });

  test("annotates foreground mode when autostarted is false", () => {
    const text = formatRuntimeStatus(cfg({ socket: "/run/wb.sock" }), {
      runtime: {
        transport: "uds",
        clearance: "loopback",
        defaultCompanionModel: "qwen-local",
        permissionLevel: "strict",
        approvePaidDefault: false,
        defaultSessionBudgetUsd: 2,
        defaultPerCallBudgetUsd: 0.25,
        maxToolSteps: 7,
        models: { total: 3, local: 1, hosted: 2 },
        methods: ["runtime/status", "models/list"],
        autostarted: false,
      },
    });
    expect(text).toContain("mode: foreground");
  });

  test("omits mode line when autostarted is omitted", () => {
    const text = formatRuntimeStatus(cfg({ socket: "/run/wb.sock" }), {
      runtime: {
        transport: "uds",
        clearance: "loopback",
        defaultCompanionModel: "qwen-local",
        permissionLevel: "strict",
        approvePaidDefault: false,
        defaultSessionBudgetUsd: 2,
        defaultPerCallBudgetUsd: 0.25,
        maxToolSteps: 7,
        models: { total: 3, local: 1, hosted: 2 },
        methods: ["runtime/status", "models/list"],
      },
    });
    expect(text).not.toContain("mode:");
  });
});

describe("runStop behavior over real sockets", () => {
  test("stops a running runtime, unlinks the socket, and returns exit code 0", async () => {
    const dir = await Deno.makeTempDir({ dir: "/tmp" });
    const socketPath = `${dir}/workbench.sock`;

    let serverInstance: WorkbenchUnixServer | undefined;
    let shutdownInvoked = false;

    serverInstance = await serveWorkbenchUnix(socketPath, {
      onShutdown: async () => {
        shutdownInvoked = true;
        if (serverInstance) {
          await serverInstance.close();
        }
      },
    });

    cleanups.push(async () => {
      if (serverInstance) {
        try {
          await serverInstance.close();
        } catch {}
      }
      try {
        await Deno.remove(dir, { recursive: true });
      } catch {}
    });

    const { io, stdout } = fakeIo();
    const exitCode = await runStop(cfg({ socket: socketPath }), io);

    expect(exitCode).toBe(0);
    expect(shutdownInvoked).toBe(true);
    expect(stdout.join("")).toContain(`dyfj: runtime at ${socketPath} stopped`);

    // Verify the socket is no longer present
    await expect(Deno.stat(socketPath)).rejects.toBeInstanceOf(
      Deno.errors.NotFound,
    );
  });

  test("is idempotent when socket does not exist", async () => {
    const dir = await Deno.makeTempDir({ dir: "/tmp" });
    const socketPath = `${dir}/nonexistent.sock`;

    cleanups.push(async () => {
      try {
        await Deno.remove(dir, { recursive: true });
      } catch {}
    });

    const { io, stdout, stderr } = fakeIo();
    const exitCode = await runStop(cfg({ socket: socketPath }), io);

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("")).toContain(
      `dyfj: runtime is not running at ${socketPath}`,
    );
  });

  test("reports not running when connection is refused by a dead listener", async () => {
    const dir = await Deno.makeTempDir({ dir: "/tmp" });
    const socketPath = `${dir}/dead.sock`;

    // Create a listener and immediately close it without unlinking
    const listener = Deno.listen({ transport: "unix", path: socketPath });
    listener.close();

    cleanups.push(async () => {
      try {
        await Deno.remove(dir, { recursive: true });
      } catch {}
    });

    const { io, stdout, stderr } = fakeIo();
    const exitCode = await runStop(cfg({ socket: socketPath }), io);

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("")).toContain(
      `dyfj: runtime is not running at ${socketPath}`,
    );
  });

  test("reports failure via io.err and returns 1 when connected to a mute socket exceeding deadline", async () => {
    const dir = await Deno.makeTempDir({ dir: "/tmp" });
    const socketPath = `${dir}/mute.sock`;
    const listener = Deno.listen({ transport: "unix", path: socketPath });
    let serverConn: Deno.Conn | undefined;
    (async () => {
      try {
        for await (const conn of listener) {
          serverConn = conn;
          // Hold connection open without reading or writing
        }
      } catch {}
    })();

    cleanups.push(async () => {
      try {
        listener.close();
      } catch {}
      if (serverConn) {
        try {
          serverConn.close();
        } catch {}
      }
      try {
        await Deno.remove(dir, { recursive: true });
      } catch {}
    });

    const { io, stdout, stderr } = fakeIo();
    const exitCode = await runStop(
      cfg({ socket: socketPath }),
      io,
      undefined,
      AbortSignal.timeout(100),
    );

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("")).toContain("is unresponsive (timed out)");
  });
});
