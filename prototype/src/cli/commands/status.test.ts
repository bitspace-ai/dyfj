import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
  formatSandbox,
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
        maxToolStepsCeiling: 48,
        models: { total: 3, local: 1, hosted: 2 },
        methods: ["runtime/status", "models/list"],
      },
    });
    assert.ok(
      text.includes("tool-step limit: 7 (ceiling 48)"),
      `expected ${JSON.stringify(text)} to include the ceiling`,
    );
    assert.ok(
      text.includes("runtime: reachable"),
      `expected ${JSON.stringify(text)} to include "runtime: reachable"`,
    );
    assert.ok(
      text.includes("socket: /run/wb.sock"),
      `expected ${JSON.stringify(text)} to include "socket: /run/wb.sock"`,
    );
    assert.ok(
      text.includes("qwen-local"),
      `expected ${JSON.stringify(text)} to include "qwen-local"`,
    );
    assert.ok(
      text.includes("3 total"),
      `expected ${JSON.stringify(text)} to include "3 total"`,
    );
    assert.ok(
      text.includes("tool-step limit: 7"),
      `expected ${JSON.stringify(text)} to include "tool-step limit: 7"`,
    );
    assert.ok(
      text.includes("methods: 2"),
      `expected ${JSON.stringify(text)} to include "methods: 2"`,
    );
    // The runtime omits the trust field here (older/incomplete response), so the
    // stance is unknown — never asserted "off" without evidence.
    assert.ok(
      text.includes("workspace instructions: unknown"),
      `expected ${
        JSON.stringify(text)
      } to include "workspace instructions: unknown"`,
    );
    // No server-resolved bare-turn route in the payload (older server) — the
    // line is omitted rather than rendered with unknowns.
    assert.ok(!text.includes("bare-turn route"));
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
    assert.ok(
      render(true).includes("workspace instructions: trusted"),
      `expected render(true) to include "workspace instructions: trusted"`,
    );
    // Literal false pins "off" to real evidence, never inferred from absence.
    assert.ok(
      render(false).includes("workspace instructions: off"),
      `expected render(false) to include "workspace instructions: off"`,
    );
    assert.ok(
      render(undefined).includes("workspace instructions: unknown"),
      `expected render(undefined) to include "workspace instructions: unknown"`,
    );
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
    assert.ok(
      text.includes("default model: claude-opus-4-8"),
      `expected ${
        JSON.stringify(text)
      } to include "default model: claude-opus-4-8"`,
    );
    assert.ok(
      text.includes("bare-turn route: qwen-local (tier 0, local)"),
      `expected ${
        JSON.stringify(text)
      } to include "bare-turn route: qwen-local (tier 0, local)"`,
    );
  });

  it("formatRuntimeStatus renders an unavailable bare-turn route on explicit null", () => {
    // The server tried and bare-turn selection failed (any cause — the null
    // carries no reason) — say so rather than silently omitting the line
    // (omission is reserved for older servers that never sent the field).
    const text = formatRuntimeStatus(cfg(), {
      runtime: { defaultTurnModel: null },
    });
    // The full line is contractual operator guidance — pin it verbatim.
    assert.ok(
      text.includes(
        "bare-turn route: unavailable (selection failed — check the model " +
          "registry and default model)",
      ),
      `expected ${
        JSON.stringify(text)
      } to include "bare-turn route: unavailable (selection failed — check the model " +
        "registry and default model)"`,
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
    assert.strictEqual(code, 0);
    const out = stdout.join("");
    assert.ok(
      out.includes("runtime: reachable"),
      `expected ${JSON.stringify(out)} to include "runtime: reachable"`,
    );
    assert.ok(
      out.includes("/run/wb.sock"),
      `expected ${JSON.stringify(out)} to include "/run/wb.sock"`,
    );
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
    assert.strictEqual(code, 1);
    assert.ok(
      stdout.join("").includes("runtime: unreachable"),
      `expected stdout.join("") to include "runtime: unreachable"`,
    );
    assert.ok(
      stderr.join("\n").includes("dyfj start"),
      `expected stderr.join("\\n") to include "dyfj start"`,
    );
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
    assert.ok(
      text.includes("launch: autostarted (background)"),
      `expected ${
        JSON.stringify(text)
      } to include "launch: autostarted (background)"`,
    );
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
    assert.ok(
      text.includes("launch: manual"),
      `expected ${JSON.stringify(text)} to include "launch: manual"`,
    );
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
    assert.ok(!text.includes("launch:"));
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
    assert.strictEqual(res.live, true);
    assert.strictEqual(res.statusPayload, undefined);
    assert.deepStrictEqual(calls, ["runtime/liveness"]);
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
    assert.strictEqual(res.live, true);
    assert.deepStrictEqual(res.statusPayload, statusPayload);
    assert.deepStrictEqual(calls, ["runtime/liveness", "runtime/status"]);
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

    await assert.rejects(
      () => probeRuntimeLiveness(client),
      (error: unknown) =>
        error instanceof Error && error.message.includes("Internal error"),
    );
    assert.deepStrictEqual(calls, ["runtime/liveness"]);
  });
});

describe("formatUnavailableSecrets", () => {
  it("names each failed pointer and says to restart after fixing it", () => {
    const lines = formatUnavailableSecrets([
      { envVar: "OPENROUTER_API_KEY", reason: "session probe failed" },
      { name: "linear", reason: "skipped" },
    ]);
    assert.deepStrictEqual(
      lines[0],
      "secret unavailable since start: OPENROUTER_API_KEY (session probe failed)",
    );
    assert.deepStrictEqual(
      lines[1],
      "secret unavailable since start: [secrets.named] linear (skipped)",
    );
    assert.ok(
      lines[2].includes("fix what the reason names"),
      `expected lines[2] to include "fix what the reason names"`,
    );
    assert.ok(
      lines[2].includes("restart it"),
      `expected lines[2] to include "restart it"`,
    );
  });

  it("prints nothing for a clean start or an older runtime", () => {
    assert.deepStrictEqual(formatUnavailableSecrets(undefined), []);
    assert.deepStrictEqual(formatUnavailableSecrets([]), []);
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
    assert.ok(
      rendered.includes(
        "secret unavailable since start: OPENROUTER_API_KEY (locked)",
      ),
      `expected ${
        JSON.stringify(rendered)
      } to include "secret unavailable since start: OPENROUTER_API_KEY (locked)"`,
    );
  });
});

describe("dyfj status code fingerprint", () => {
  const fingerprint = {
    head: "0123456789abcdef0123456789abcdef01234567",
    contentHash: `sha256:${"c".repeat(64)}`,
  };

  it("shows the runtime's code version, open clients and turns in flight", () => {
    const text = formatRuntimeStatus(cfg(), {
      runtime: { fingerprint, clients: 2, inFlightTurns: 1 },
    });
    assert.match(
      text,
      /^code: 0123456789ab · sha256:cccccccccccc$/m,
    );
    assert.match(text, /^clients: 2 · turns in flight: 1$/m);
  });

  it("compares the runtime's code with this checkout's", () => {
    const behind = formatRuntimeStatus(
      cfg(),
      { runtime: { fingerprint } },
      `sha256:${"d".repeat(64)}`,
    );
    assert.match(behind, /^code: .* \(runtime is behind the working tree\)$/m);
    const current = formatRuntimeStatus(
      cfg(),
      { runtime: { fingerprint } },
      fingerprint.contentHash,
    );
    assert.match(current, /^code: .* \(matches the working tree\)$/m);
  });

  it("names an unknown HEAD or hash rather than inventing one", () => {
    const text = formatRuntimeStatus(cfg(), {
      runtime: { fingerprint: { head: "unknown", contentHash: "unknown" } },
    }, `sha256:${"d".repeat(64)}`);
    assert.match(text, /^code: unknown · unknown$/m);
  });

  it("an older runtime without these fields keeps the older output", () => {
    const text = formatRuntimeStatus(cfg(), { runtime: {} }, fingerprint.contentHash);
    assert.doesNotMatch(text, /^code:/m);
    assert.doesNotMatch(text, /^clients:/m);
  });
});

describe("dyfj status external MCP lines", () => {
  const lines = [
    'external MCP linear: configured tool "create_comment" not offered by the server',
    "external MCP linear: ready (3 tools, 2026-07-28)",
  ];

  it("shows the boot's external MCP lines, warnings by name", () => {
    const rendered = formatRuntimeStatus(cfg(), {
      runtime: { externalMcp: lines },
    }).split("\n");
    for (const line of lines) {
      assert.ok(rendered.includes(line), `expected status to show ${line}`);
    }
  });

  it("prints no external MCP line for an older runtime or no servers", () => {
    for (const runtime of [{}, { externalMcp: [] }]) {
      assert.ok(
        !formatRuntimeStatus(cfg(), { runtime }).includes("external MCP"),
      );
    }
  });

  it("strips control characters a runtime might send", () => {
    const rendered = formatRuntimeStatus(cfg(), {
      runtime: { externalMcp: ["external MCP x\u001b[2J: ready", 7 as never] },
    });
    assert.ok(rendered.includes("external MCP x[2J: ready"));
    assert.ok(!rendered.includes("\u001b"));
  });
});

describe("the sandbox line (BIT-662)", () => {
  it("names the backend when the sandbox is on", () => {
    assert.equal(
      formatSandbox({ state: "on", backend: "srt 0.0.81" }),
      "sandbox srt 0.0.81",
    );
  });

  it("says commands ask, and why, when it is off", () => {
    assert.equal(
      formatSandbox({ state: "off", backend: "srt 0.0.81", reason: "DYFJ_SANDBOX=off" }),
      "sandbox OFF (DYFJ_SANDBOX=off): commands ask",
    );
  });

  it("is absent for a runtime that reports no sandbox", () => {
    assert.equal(formatSandbox(undefined), null);
    const text = formatRuntimeStatus(cfg(), { runtime: { permissionLevel: "strict" } });
    assert.doesNotMatch(text, /sandbox/);
  });

  it("dyfj status shows it under the permission line", () => {
    const text = formatRuntimeStatus(cfg(), {
      runtime: {
        permissionLevel: "operator",
        sandbox: { state: "off", backend: "srt 0.0.81", reason: "DYFJ_SANDBOX=off" },
      },
    });
    assert.match(text, /permission: operator\nsandbox OFF \(DYFJ_SANDBOX=off\): commands ask/);
  });
});
