import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MapEnv } from "../testing/fakes/map-env.ts";
import { defineGit } from "./tools/builtin/git.ts";
import { compileWorkspacePolicy } from "./tools/builtin/srt-policy.ts";
import { offSandbox, type CommandSandbox } from "./tools/builtin/srt-sandbox.ts";
import { evaluateCommandPolicy } from "./tools/policy.ts";
import { bindCodexTurn, bridgedTools, type BridgeTurn, type ExternalAgentToolBridge } from "./workbench-tool-bridge.ts";

function capture() {
  let active: BridgeTurn | undefined;
  let binds = 0;
  const dependency: ExternalAgentToolBridge = {
    toolTimeoutSeconds: 300,
    bridge: async () => ({
      socketPath: "/unused/tools.sock",
      bind: () => { binds++; return "token"; },
      activate: (_session, turn) => { active = turn; return () => {}; },
    }),
  };
  return { dependency, turn: () => { assert.ok(active); return active; }, binds: () => binds };
}

const runner = { profile: "codex-chatgpt" };
const env = new MapEnv({});
const call = {
  commandId: "git", callId: "commit",
  caller: { principalId: "model", principalType: "agent" } as const,
  arguments: { subcommand: "commit", message: "test" },
};

function sandboxFor(roots: string[]): CommandSandbox {
  return {
    status: { state: "on", backend: "test" },
    policy: (root) => compileWorkspacePolicy(root, { readLayout: async () => null }),
    runShell: async () => { throw new Error("unexpected shell"); },
    runArgv: async (_argv, run) => {
      roots.push(run.root);
      assert.equal(run.cwd, run.root);
      return { code: 0, signal: null, stdout: "committed", stderr: "", timedOut: false };
    },
  };
}

test("binds git alone for a Codex workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-git-"));
  try {
    const h = capture();
    const bound = await bindCodexTurn(h.dependency, "session", { runner, workspaceRoot: root });
    assert.ok(bound, "workspace must bind git without dispatch or MCP");
    bound.activate("trace", "span", async () => {});
    assert.equal(h.binds(), 1);
    assert.deepEqual(bridgedTools(h.turn().commands).map(tool => tool.name), ["git"]);
    assert.deepEqual(h.turn().policy, { permissionLevel: "strict", loopback: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("without a workspace or other tools the bridge remains unbound", async () => {
  const h = capture();
  assert.equal(await bindCodexTurn(h.dependency, "session", { runner }), undefined);
  assert.equal(h.binds(), 0);
});

test("bridged git runs only in the primary workspace with an added directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-git-"));
  try {
    const added = join(root, "added");
    await mkdir(added);
    const roots: string[] = [];
    const h = capture();
    const input = { runner, workspaceRoot: root, additionalRoots: [{ path: added, mode: "read-write" }] };
    const bound = await bindCodexTurn(h.dependency, "session", input, { env, sandbox: sandboxFor(roots) });
    assert.ok(bound, "primary workspace git must be offered");
    bound.activate("trace", "span", async () => {});
    const git = h.turn().commands.find(command => command.id === "git");
    assert.ok(git);
    assert.match(String(await git.executor(call, { authzBasis: "policy:allow:sandboxed" })), /^exit 0/m);
    assert.ok(roots.length > 0);
    assert.deepEqual([...new Set(roots)], [root]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const permissionLevel of ["strict", "operator"] as const) {
  for (const on of [false, true]) {
    test(`bridged commit policy equals native: ${permissionLevel}, sandbox ${on ? "on" : "off"}`, async () => {
      const root = await mkdtemp(join(tmpdir(), "bridge-git-"));
      try {
        const sandbox = on ? sandboxFor([]) : offSandbox("test");
        const ports = { env, sandbox };
        const h = capture();
        const bound = await bindCodexTurn(h.dependency, "session", { runner, workspaceRoot: root, permissionLevel }, ports);
        assert.ok(bound, "workspace git must be offered for policy parity");
        bound.activate("trace", "span", async () => {});
        const bridged = h.turn().commands.find(command => command.id === "git");
        assert.ok(bridged);
        const native = defineGit(root, ports);
        const context = { permissionLevel, loopback: true };
        const verdict = await bridged.containment?.attest();
        const actual = evaluateCommandPolicy(bridged, call, { ...h.turn().policy, containment: verdict });
        const expected = evaluateCommandPolicy(native, call, { ...context, containment: await native.containment?.attest() });
        assert.deepEqual(actual, expected);
        assert.equal(actual.decision, on && permissionLevel === "operator" ? "allow" : "ask");
        assert.equal(actual.authzBasis, on && permissionLevel === "operator" ? "policy:allow:sandboxed" : "policy:ask:default");
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  }
}
