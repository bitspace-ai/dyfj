// A canary for the Workbench tool bridge under the pinned Codex: the route's
// `mcp_servers.workbench` entry (`codexWorkbenchToolsServer`) is accepted,
// Codex starts the shim and reaches the bridge, and a tool call Codex makes
// reaches Workbench's invoke path. Codex's app-server is driven directly:
// `thread/start` with the entry in the thread's config, as codex-acp passes
// it, then `mcpServer/tool/call`. No model and no sign-in are involved, and
// the thread's model provider points at loopback port 9, which nothing is
// expected to serve; the test requests no model inference.
//
// The write case checks that, on this direct tool-call RPC, Codex sends no
// approval request of its own for a bridged tool
// (`default_tools_approval_mode = "approve"`): the call reaches the bridge,
// whose Workbench approver decides it. A Codex approval request would arrive
// as a request this test never answers, and the call would time out. A model
// turn's tool calls are not exercised here; the UAT covers one.
import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { after, before, describe, it } from "node:test";
import { nestedSandboxSkipReason } from "../testing/nested-sandbox.ts";
import { unixSocketBindSkip } from "../testing/unix-socket-bind.ts";
import { codexAcpPackageRoot, ownPrototypeRoot } from "./acp-adapter-package.ts";
import { CODEX_HOME_CONFIG_TOML } from "./codex-home-config.ts";
import { bundledCodexExecutable } from "./external-agent-runtime.ts";
import type { CommandDefinition, ToolApprovalRequest } from "./tools/mod.ts";
import {
  codexWorkbenchToolsServer,
  WorkbenchToolBridge,
} from "./workbench-tool-bridge.ts";

const skip = nestedSandboxSkipReason() ?? await unixSocketBindSkip() ?? false;

if (skip !== false) it("runs the Codex tool bridge canary", { skip }, () => {});

function command(id: string, write: boolean, ran: string[]): CommandDefinition {
  return {
    id,
    title: id,
    description: `the ${id} command`,
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
    permission: {
      effects: [write ? "write.external" : "read.external"],
      defaultDecision: write ? "ask" : "allow",
      resources: [],
      network: "configured-external",
      filesystem: "none",
      cost: "none",
    },
    executor: (call) => {
      ran.push(`${id}:${String(call.arguments.id)}`);
      return Promise.resolve(`${id} body`);
    },
  };
}

/** How long one app-server request or awaited notification may take. */
const APP_SERVER_TIMEOUT_MS = 30_000;

/** Reject `promise` if it has not settled after APP_SERVER_TIMEOUT_MS. */
function bounded<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`the Codex app-server did not answer ${what}`)),
        APP_SERVER_TIMEOUT_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/** One app-server process and a request/response helper over its stdio. */
class AppServer {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #exited: Promise<unknown>;
  readonly #pending = new Map<number, (message: Record<string, unknown>) => void>();
  readonly #listeners: Array<(message: Record<string, unknown>) => void> = [];
  #nextId = 1;

  constructor(codex: string, home: string, workspace: string) {
    this.#child = spawn(process.execPath, [codex, "app-server"], {
      cwd: workspace,
      env: { HOME: home, CODEX_HOME: join(home, ".codex"), PATH: "/usr/bin:/bin" },
    });
    this.#exited = new Promise((resolve) => this.#child.once("exit", resolve));
    this.#child.stderr.resume();
    createInterface({ input: this.#child.stdout }).on("line", (line) => {
      const message = JSON.parse(line) as Record<string, unknown>;
      if (typeof message.id === "number" && !("method" in message)) {
        this.#pending.get(message.id)?.(message);
        this.#pending.delete(message.id);
        return;
      }
      for (const listener of this.#listeners) listener(message);
    });
  }

  request(method: string, params: unknown): Promise<Record<string, unknown>> {
    const id = this.#nextId++;
    return bounded(
      new Promise((resolve) => {
        this.#pending.set(id, resolve);
        this.#child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      }),
      method,
    );
  }

  notify(method: string): void {
    this.#child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  }

  waitFor(match: (message: Record<string, unknown>) => boolean, what: string) {
    return bounded(
      new Promise<Record<string, unknown>>((resolve) => {
        this.#listeners.push((message) => {
          if (match(message)) resolve(message);
        });
      }),
      what,
    );
  }

  async close(): Promise<void> {
    this.#child.kill();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const exitedOrKilled = Promise.race([
      this.#exited,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          this.#child.kill("SIGKILL");
          resolve();
        }, 5_000);
      }),
    ]);
    await exitedOrKilled.finally(() => clearTimeout(timer));
    await bounded(this.#exited, "SIGKILL");
  }
}

describe("the pinned Codex reaches Workbench tools through the bridge", { skip }, () => {
  let root = "";
  let bridge: WorkbenchToolBridge;
  let server: AppServer;
  let threadId = "";
  let release = () => {};
  const ran: string[] = [];
  const asked: ToolApprovalRequest[] = [];

  before(async () => {
    root = realpathSync(mkdtempSync("/tmp/dyfj-cb-"));
    const home = join(root, "home");
    const workspace = join(root, "ws");
    mkdirSync(join(home, ".codex"), { recursive: true, mode: 0o700 });
    mkdirSync(workspace);
    writeFileSync(join(home, ".codex", "config.toml"), CODEX_HOME_CONFIG_TOML, {
      mode: 0o600,
    });
    bridge = await WorkbenchToolBridge.start(root);
    release = bridge.activate("canary-session", {
      commands: [
        command("mcp.linear.get_issue", false, ran),
        command("mcp.linear.save_comment", true, ran),
      ],
      confirmApproval: (request) => {
        asked.push(request);
        return Promise.resolve({ decision: "deny", reason: "canary" });
      },
      policy: { permissionLevel: "strict", loopback: true },
      traceId: "0".repeat(32),
      parentSpanId: "1".repeat(16),
      writeEvent: () => {},
    });
    const codex = await bundledCodexExecutable(
      await codexAcpPackageRoot(ownPrototypeRoot()),
    );
    server = new AppServer(codex, home, workspace);
    await server.request("initialize", { clientInfo: { name: "dyfj-canary", version: "0" } });
    server.notify("initialized");
    const ready = server.waitFor((message) =>
      message.method === "mcpServer/startupStatus/updated" &&
      (message.params as { name?: string }).name === "workbench" &&
      (message.params as { status?: string }).status !== "starting",
      "the workbench server's startup status");
    const started = await server.request("thread/start", {
      cwd: workspace,
      config: {
        sandbox_mode: "workspace-write",
        model_provider: "dyfj_canary",
        model_providers: {
          dyfj_canary: {
            name: "dyfj_canary",
            base_url: "http://127.0.0.1:9/v1",
            wire_api: "responses",
          },
        },
        mcp_servers: {
          workbench: codexWorkbenchToolsServer(process.execPath, {
            socketPath: bridge.socketPath,
            token: bridge.bind("canary-session"),
            toolTimeoutSeconds: 120,
          }),
        },
      },
    });
    threadId = ((started.result as { thread: { id: string } }).thread).id;
    const status = await ready;
    assert.equal((status.params as { status: string }).status, "ready");
  });

  after(async () => {
    release();
    await server?.close();
    await bridge?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("runs a read tool and returns its result to Codex", async () => {
    const reply = await server.request("mcpServer/tool/call", {
      threadId,
      server: "workbench",
      tool: "mcp_linear_get_issue",
      arguments: { id: "BIT-1" },
    });
    assert.deepEqual(reply.result, {
      content: [{ type: "text", text: "mcp.linear.get_issue body" }],
      isError: false,
    });
    assert.deepEqual(ran, ["mcp.linear.get_issue:BIT-1"]);
  });

  it("puts an ask tool to the Workbench approver, not to a Codex prompt", async () => {
    const reply = await server.request("mcpServer/tool/call", {
      threadId,
      server: "workbench",
      tool: "mcp_linear_save_comment",
      arguments: { id: "BIT-2" },
    });
    assert.equal((reply.result as { isError: boolean }).isError, true);
    assert.deepEqual(asked.map((request) => request.commandId), [
      "mcp.linear.save_comment",
    ]);
    assert.equal(ran.includes("mcp.linear.save_comment:BIT-2"), false);
  });
});
