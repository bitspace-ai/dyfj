import {
  assertEquals,
  assertFalse,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  RpcError,
  RpcErrorCode,
  type UnixClient,
} from "../../transport/mod.ts";
import { fakeIo } from "../../../testing/fakes/fake-io.ts";
import type { CliConfig } from "../args.ts";
import type { ConnectFn } from "../io.ts";
import {
  formatRuntimeStatus,
  formatUnavailableSecrets,
  probeRuntimeLiveness,
  runStatus,
} from "./status.ts";

function cfg(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    socket: "/tmp/dyfj-test.sock",
    mode: "turn",
    color: false,
    ...overrides,
  };
}

describe("runtime lifecycle commands", () => {
  function fakeConnect(responses: Record<string, unknown>): ConnectFn {
    return (_socketPath: string) =>
      Promise.resolve({
        request: (method: string) => Promise.resolve(responses[method]),
        close: () => {},
      });
  }

  it("formatRuntimeStatus gives an operator-readable local snapshot", () => {
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
    assertStringIncludes(text, "runtime: reachable");
    assertStringIncludes(text, "socket: /run/wb.sock");
    assertStringIncludes(text, "qwen-local");
    assertStringIncludes(text, "3 total");
    assertStringIncludes(text, "tool-step limit: 7");
    assertStringIncludes(text, "methods: 2");
    // The runtime omits the trust field here (older/incomplete response), so the
    // stance is unknown — never asserted "off" without evidence.
    assertStringIncludes(text, "workspace instructions: unknown");
    // No server-resolved bare-turn route in the payload (older server) — the
    // line is omitted rather than rendered with unknowns.
    assertFalse(text.includes("bare-turn route"));
  });

  it("formatRuntimeStatus reports the workspace-instruction trust state", () => {
    const render = (trust?: boolean) =>
      formatRuntimeStatus(cfg({ socket: "/run/wb.sock" }), {
        runtime: {
          transport: "uds",
          clearance: "loopback",
          ...(trust === undefined ? {} : { trustWorkspaceInstructions: trust }),
        },
      });
    assertStringIncludes(render(true), "workspace instructions: trusted");
    // Literal false pins "off" to real evidence, never inferred from absence.
    assertStringIncludes(render(false), "workspace instructions: off");
    assertStringIncludes(render(undefined), "workspace instructions: unknown");
  });

  it("formatRuntimeStatus shows the resolved bare-turn route when reported", () => {
    const text = formatRuntimeStatus(cfg({ socket: "/run/wb.sock" }), {
      runtime: {
        defaultCompanionModel: "claude-opus-4-8",
        defaultTurnModel: { slug: "qwen-local", tier: 0, local: true },
      },
    });
    // The configured default and the actual bare-turn route can differ under
    // the local-by-default posture; status shows both.
    assertStringIncludes(text, "default model: claude-opus-4-8");
    assertStringIncludes(text, "bare-turn route: qwen-local (tier 0, local)");
  });

  it("formatRuntimeStatus renders an unavailable bare-turn route on explicit null", () => {
    // The server tried and bare-turn selection failed (any cause — the null
    // carries no reason) — say so rather than silently omitting the line
    // (omission is reserved for older servers that never sent the field).
    const text = formatRuntimeStatus(cfg(), {
      runtime: { defaultTurnModel: null },
    });
    // The full line is contractual operator guidance — pin it verbatim.
    assertStringIncludes(
      text,
      "bare-turn route: unavailable (selection failed — check the model " +
        "registry and default model)",
    );
  });

  it("runStatus reports reachable runtime details", async () => {
    const { io, stdout } = fakeIo();
    const code = await runStatus(
      cfg({ socket: "/run/wb.sock" }),
      io,
      fakeConnect({
        "runtime/status": {
          runtime: {
            transport: "uds",
            clearance: "loopback",
            models: { total: 1, local: 1, hosted: 0 },
            methods: ["runtime/status"],
          },
        },
      }),
    );
    assertStrictEquals(code, 0);
    const out = stdout.join("");
    assertStringIncludes(out, "runtime: reachable");
    assertStringIncludes(out, "/run/wb.sock");
  });

  it("runStatus reports unreachable runtime and start hint", async () => {
    const { io, stdout, stderr } = fakeIo();
    const code = await runStatus(
      cfg({ socket: "/run/missing.sock" }),
      io,
      () => {
        throw new Error("No such file or directory (os error 2)");
      },
    );
    assertStrictEquals(code, 1);
    assertStringIncludes(stdout.join(""), "runtime: unreachable");
    assertStringIncludes(stderr.join("\n"), "dyfj start");
  });
});

describe("formatRuntimeStatus launch annotations", () => {
  it("annotates background autostarted launch when autostarted is true", () => {
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
    assertStringIncludes(text, "launch: autostarted (background)");
  });

  it("annotates manual launch when autostarted is false", () => {
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
    assertStringIncludes(text, "launch: manual");
  });

  it("omits launch line when autostarted is omitted", () => {
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
    assertFalse(text.includes("launch:"));
  });
});

describe("probeRuntimeLiveness fallback logic", () => {
  it("succeeds directly when server implements runtime/liveness", async () => {
    const calls: string[] = [];
    const client: UnixClient = {
      request: (method) => {
        calls.push(method);
        if (method === "runtime/liveness") {
          return Promise.resolve({
            status: "ok",
            transport: "uds",
            clearance: "loopback",
          });
        }
        return Promise.reject(new Error(`Unexpected method ${method}`));
      },
      close: () => {},
    };

    const res = await probeRuntimeLiveness(client);
    assertStrictEquals(res.live, true);
    assertStrictEquals(res.statusPayload, undefined);
    assertEquals(calls, ["runtime/liveness"]);
  });

  it("falls back once to runtime/status when server returns MethodNotFound (-32601)", async () => {
    const calls: string[] = [];
    const statusPayload = {
      runtime: {
        transport: "uds",
        clearance: "loopback",
        models: { total: 1, local: 1, hosted: 0 },
        methods: ["runtime/status"],
      },
    };

    const client: UnixClient = {
      request: (method) => {
        calls.push(method);
        if (method === "runtime/liveness") {
          return Promise.reject(
            new RpcError(RpcErrorCode.methodNotFound, "Method not found"),
          );
        }
        if (method === "runtime/status") {
          return Promise.resolve(statusPayload);
        }
        return Promise.reject(new Error(`Unexpected method ${method}`));
      },
      close: () => {},
    };

    const res = await probeRuntimeLiveness(client);
    assertStrictEquals(res.live, true);
    assertEquals(res.statusPayload, statusPayload);
    assertEquals(calls, ["runtime/liveness", "runtime/status"]);
  });

  it("re-throws unexpected RPC errors without falling back", async () => {
    const calls: string[] = [];
    const client: UnixClient = {
      request: (method) => {
        calls.push(method);
        return Promise.reject(
          new RpcError(RpcErrorCode.internalError, "Internal error"),
        );
      },
      close: () => {},
    };

    await assertRejects(
      () => probeRuntimeLiveness(client),
      Error,
      "Internal error",
    );
    assertEquals(calls, ["runtime/liveness"]);
  });
});

describe("formatUnavailableSecrets", () => {
  it("names each failed pointer and says to restart after unlocking", () => {
    const lines = formatUnavailableSecrets([
      { envVar: "OPENROUTER_API_KEY", reason: "session probe failed" },
    ]);
    assertEquals(
      lines[0],
      "secret unavailable since start: OPENROUTER_API_KEY (session probe failed)",
    );
    assertStringIncludes(lines[1], "restart the runtime");
  });

  it("prints nothing for a clean start or an older runtime", () => {
    assertEquals(formatUnavailableSecrets(undefined), []);
    assertEquals(formatUnavailableSecrets([]), []);
  });

  it("appears in dyfj status output", () => {
    const rendered = formatRuntimeStatus(cfg(), {
      runtime: {
        unavailableSecrets: [{
          envVar: "OPENROUTER_API_KEY",
          reason: "locked",
        }],
      },
    });
    assertStringIncludes(
      rendered,
      "secret unavailable since start: OPENROUTER_API_KEY (locked)",
    );
  });
});
