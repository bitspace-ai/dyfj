import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { MapEnv } from "../../../testing/fakes/map-env.ts";
import { buildToolCatalog } from "../catalog.ts";
import { evaluateCommandPolicy } from "../policy.ts";
import { invokeCommand } from "../invoke.ts";
import { createCommandRegistry } from "../registry.ts";
import { offSandbox } from "./srt-sandbox.ts";
import { isBridgedCommand } from "../../workbench-tool-bridge.ts";
import type { CommandCall, CommandDefinition } from "../definition.ts";

const call = (mode: string, paths?: string[]): CommandCall => ({
  commandId: "gate/start", callId: "c", caller: { principalId: "m", principalType: "agent" },
  arguments: { mode, reason: "Run the configured gate", ...(paths ? { paths } : {}) },
});
const config = { commands: { full: ["npm", "test"], files: ["node", "--test"], fast: ["npm", "run", "test:fast"] }, timeoutSeconds: 1800 };
const sandbox = { ...offSandbox("test"), status: { state: "on", backend: "test" } as const };
async function definitions(options = {}) {
  const { defineGateTools } = await import("./gate.ts");
  const { GateRuns } = await import("./gate-runs.ts");
  return defineGateTools({ config, runs: new GateRuns(), sessionId: "s", workspaceRoot: "/work", env: new MapEnv({}), sandbox, ...options });
}

it("gate catalog: absent config leaves native and bridge without gate tools", () => {
  const commands = buildToolCatalog({}, {}).list();
  assert.equal(commands.some(c => c.id.startsWith("gate/")), false);
  assert.equal(commands.filter(isBridgedCommand).some(c => c.id.startsWith("gate/")), false);
});

it("gate modes: command only, sandbox off, missing sandbox, and executor socket omit files and fast", async () => {
  for (const options of [
    { config: { ...config, commands: { full: config.commands.full } } },
    { sandbox: offSandbox("off") }, { sandbox: undefined },
    { env: new MapEnv({ DYFJ_EXECUTOR_SOCKET: "/executor.sock" }) },
  ]) {
    const [start] = await definitions(options);
    assert.deepEqual(start.inputSchema.properties?.mode.enum, ["full"]);
  }
});

it("gate fast: offered with a sandbox and refuses paths", async () => {
  const [start] = await definitions();
  assert.deepEqual(start.inputSchema.properties?.mode.enum, ["full", "files", "fast"]);
  assert.equal(await start.precheck!(call("fast")), null);
  assert.equal(await start.precheck!(call("fast", ["a.test.ts"])), "gate: paths applies only to files mode");
});

it("gate bridge: admits all three ids and still refuses bash and read_file", () => {
  for (const id of ["gate/start", "gate/wait", "gate/cancel"]) {
    assert.equal(isBridgedCommand({ id } as CommandDefinition), true, id);
  }
  for (const id of ["bash", "read_file"]) assert.equal(isBridgedCommand({ id } as CommandDefinition), false);
});

for (const mode of ["files", "fast"]) it(`gate policy: ${mode} is sandbox allowed only under operator on loopback`, async () => {
  const [start] = await definitions();
  const containment = await start.containment!.attest();
  assert.deepEqual(evaluateCommandPolicy(start, call(mode, mode === "files" ? ["a.test.ts"] : undefined), {
    permissionLevel: "operator", loopback: true, containment,
  }), { decision: "allow", authzBasis: "policy:allow:sandboxed" });
  for (const context of [{ permissionLevel: "strict" as const, loopback: true }, { permissionLevel: "operator" as const, loopback: false }]) {
    assert.equal(evaluateCommandPolicy(start, call(mode, mode === "files" ? ["a.test.ts"] : undefined), { ...context, containment }).decision, "ask");
  }
});

it("gate policy: full asks without a grant offer under strict and operator", async () => {
  for (const permissionLevel of ["strict", "operator"] as const) {
    const [start] = await definitions();
    const registry = createCommandRegistry(); registry.register(start);
    let prompts = 0;
    const result = await invokeCommand(registry, call("full"), async request => {
      prompts++; assert.notEqual(request.grantable, true); return { decision: "deny" };
    }, { permissionLevel, loopback: true, sessionGrants: new Set<string>() });
    assert.equal(prompts, 1); assert.equal(result.decision, "deny");
  }
});

it("gate files: refuses absolute, traversal, missing and escaping symlink paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "gate-paths-"));
  try {
    await writeFile(join(root, "test.ts"), "");
    await symlink(process.execPath, join(root, "outside"));
    const [start] = await definitions({ workspaceRoot: root });
    for (const paths of [[join(root, "test.ts")], ["../test.ts"], ["missing.ts"], ["outside"], []]) {
      assert.notEqual(await start.precheck!(call("files", paths)), null, JSON.stringify(paths));
    }
    assert.equal(await start.precheck!(call("files", ["test.ts"])), null);
    assert.notEqual(await start.precheck!(call("full", ["test.ts"])), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("gate policy: wait and cancel need no approval under strict", async () => {
  const tools = await definitions();
  for (const command of tools.slice(1)) {
    const request = { ...call("full"), commandId: command.id, arguments: { run: "unknown" } };
    assert.equal(evaluateCommandPolicy(command, request, { permissionLevel: "strict" }).decision, "allow");
    assert.equal((await command.executor(request, { authzBasis: "test" })).state, "unknown");
  }
});
