// The srt sandbox's policy, boot and approval routing (BIT-662), with srt and
// git faked. The real sandbox is exercised in `srt-sandbox.integration.test.ts`.

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MapEnv } from "../../../testing/fakes/map-env.ts";
import type { CommandCall } from "../definition.ts";
import { evaluateCommandPolicy } from "../policy.ts";
import { invokeCommand } from "../invoke.ts";
import { createCommandRegistry } from "../registry.ts";
import type { BoundedResult } from "./bounded-process.ts";
import { defineBash } from "./exec.ts";
import { defineGit } from "./git.ts";
import {
  compileWorkspacePolicy,
  CREDENTIAL_READ_DENY,
  type GitLayout,
} from "./srt-policy.ts";
import {
  bootSandbox,
  type CommandSandbox,
  describeSandbox,
  ensureScratchDir,
  offSandbox,
  sandboxNetwork,
  type SrtLibrary,
} from "./srt-sandbox.ts";

let base = "";
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "srt-unit-")));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const layout = (value: GitLayout | null) => () => Promise.resolve(value);

/** A probe listener that never sees a connection. */
const fakeListener = () =>
  Promise.resolve({ port: 9, accepted: () => false, close: () => {} });

describe("the workspace policy", () => {
  it("a linked worktree may write its objects, its own metadata and only its branch's ref", async () => {
    const common = join(base, "main", ".git");
    const wt = join(base, "wt");
    mkdirSync(common, { recursive: true });
    mkdirSync(wt);
    const meta = join(common, "worktrees", "wt");
    const policy = await compileWorkspacePolicy(wt, {
      home: "/fake-home",
      readLayout: layout({
        gitDir: meta,
        commonDir: common,
        topLevel: wt,
        branchRef: "refs/heads/agent/session",
      }),
    });
    assert.equal(policy.mainCheckout, false);
    assert.deepEqual(policy.filesystem.allowWrite, [
      wt,
      join(common, "objects"),
      meta,
      join(common, "refs/heads/agent/session"),
      join(common, "refs/heads/agent/session.lock"),
      join(common, "logs/refs/heads/agent/session"),
    ]);
    assert.deepEqual(policy.filesystem.denyWrite, [
      join(common, "objects", "pack"),
      join(common, "objects", "info"),
      join(wt, ".git"),
      join(meta, "commondir"),
      join(meta, "gitdir"),
      join(meta, "config.worktree"),
    ]);
  });

  it("a detached worktree gets no branch ref", async () => {
    const common = join(base, ".git");
    mkdirSync(common);
    const policy = await compileWorkspacePolicy(base, {
      readLayout: layout({
        gitDir: join(common, "worktrees", "x"),
        commonDir: common,
        topLevel: base,
        branchRef: null,
      }),
    });
    assert.equal(
      policy.filesystem.allowWrite.some((p) => p.includes("refs")),
      false,
    );
  });

  it("a main checkout's whole .git is write-denied", async () => {
    const gitDir = join(base, ".git");
    mkdirSync(gitDir);
    const policy = await compileWorkspacePolicy(base, {
      readLayout: layout({
        gitDir,
        commonDir: gitDir,
        topLevel: base,
        branchRef: "refs/heads/main",
      }),
    });
    assert.equal(policy.mainCheckout, true);
    assert.deepEqual(policy.filesystem.allowWrite, [base]);
    assert.deepEqual(policy.filesystem.denyWrite, [gitDir]);
  });

  it("a directory outside any repository may write only itself", async () => {
    const policy = await compileWorkspacePolicy(base, { readLayout: layout(null) });
    assert.deepEqual(policy.filesystem.allowWrite, [base]);
    assert.deepEqual(policy.filesystem.denyWrite, []);
  });

  it("every built-in credential path is read-denied", async () => {
    const policy = await compileWorkspacePolicy(base, {
      home: "/fake-home",
      readLayout: layout(null),
    });
    for (
      const path of [
        ".ssh",
        ".claude/.credentials.json",
        ".codex/auth.json",
        ".config/gh",
        ".config/op",
        ".kube/config",
        ".docker/config.json",
        // The runtime's own directory (config, socket, runner homes).
        ".dyfj",
      ]
    ) {
      assert.ok(CREDENTIAL_READ_DENY.includes(path), path);
      assert.ok(policy.filesystem.denyRead.includes(`/fake-home/${path}`), path);
    }
  });

  it("[sandbox] deny_read adds home-relative and absolute paths", async () => {
    const policy = await compileWorkspacePolicy(base, {
      home: "/fake-home",
      readLayout: layout(null),
      extraDenyRead: [".example-tool/token", "/srv/example/secret.json"],
    });
    assert.ok(policy.filesystem.denyRead.includes("/fake-home/.example-tool/token"));
    assert.ok(policy.filesystem.denyRead.includes("/srv/example/secret.json"));
  });

  it("[sandbox] deny_read never removes a built-in entry", async () => {
    const policy = await compileWorkspacePolicy(base, {
      home: "/fake-home",
      readLayout: layout(null),
      extraDenyRead: [".ssh", ".example-tool/token"],
    });
    for (const path of CREDENTIAL_READ_DENY) {
      assert.ok(policy.filesystem.denyRead.includes(`/fake-home/${path}`), path);
    }
    assert.equal(
      policy.filesystem.denyRead.filter((p) => p === "/fake-home/.ssh").length,
      1,
    );
    assert.equal(policy.filesystem.denyRead.length, CREDENTIAL_READ_DENY.length + 1);
  });
});

describe("the network policy", () => {
  it("allows the npm registry by default and denies GitHub whatever is configured", () => {
    const network = sandboxNetwork(["github.com", "static.crates.io"]);
    assert.ok(network.allowedDomains.includes("registry.npmjs.org"));
    assert.ok(network.allowedDomains.includes("static.crates.io"));
    for (const domain of ["github.com", "*.github.com", "*.githubusercontent.com"]) {
      assert.ok(network.deniedDomains.includes(domain), domain);
    }
  });
});

function fakeSrt(overrides: Partial<SrtLibrary> = {}): SrtLibrary {
  return {
    isSupportedPlatform: () => true,
    checkDependencies: () => ({ errors: [] }),
    initialize: () => Promise.resolve(),
    wrapWithSandbox: (command) => Promise.resolve(command),
    cleanupAfterCommand: () => {},
    reset: () => Promise.resolve(),
    ...overrides,
  };
}

describe("the boot", () => {
  it("DYFJ_SANDBOX=off leaves the sandbox off, saying so", async () => {
    let initialized = false;
    const sandbox = await bootSandbox({
      listenProbe: fakeListener,
      env: new MapEnv({ DYFJ_SANDBOX: "off" }),
      srt: fakeSrt({ initialize: () => { initialized = true; return Promise.resolve(); } }),
    });
    assert.equal(initialized, false);
    assert.deepEqual(sandbox.status, {
      state: "off",
      backend: "srt 0.0.81",
      reason: "DYFJ_SANDBOX=off",
    });
    assert.equal(
      describeSandbox(sandbox.status),
      "sandbox OFF (DYFJ_SANDBOX=off): commands ask",
    );
  });

  it("an unsupported platform or a missing dependency leaves it off", async () => {
    const unsupported = await bootSandbox({
      listenProbe: fakeListener,
      env: new MapEnv({}),
      srt: fakeSrt({ isSupportedPlatform: () => false }),
    });
    assert.match((unsupported.status as { reason: string }).reason, /unsupported platform/);
    const missing = await bootSandbox({
      listenProbe: fakeListener,
      env: new MapEnv({}),
      srt: fakeSrt({ checkDependencies: () => ({ errors: ["bwrap not found"] }) }),
      scratchDir: join(base, "scratch"),
    });
    assert.match((missing.status as { reason: string }).reason, /bwrap not found/);
  });

  it("a sandbox that does not wrap commands fails the boot probe", async () => {
    let reset = false;
    const sandbox = await bootSandbox({
      listenProbe: fakeListener,
      env: new MapEnv({ PATH: process.env.PATH ?? "/usr/bin:/bin" }),
      srt: fakeSrt({ reset: () => { reset = true; return Promise.resolve(); } }),
      scratchDir: join(base, "scratch"),
      readLayout: layout(null),
    });
    assert.equal(sandbox.status.state, "off");
    assert.match(
      (sandbox.status as { reason: string }).reason,
      /boot probe failed: .*did not wrap/,
    );
    assert.equal(reset, true);
  });

  it("refuses a scratch directory that others can write", () => {
    const dir = join(base, "scratch");
    mkdirSync(dir);
    chmodSync(dir, 0o777);
    assert.throws(() => ensureScratchDir(dir), /writable by group or others/);
  });

  it("creates a missing scratch directory owner-only", () => {
    const dir = join(base, "scratch");
    ensureScratchDir(dir);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  });
});

/** A sandbox that is on and records what it ran. */
function recordingSandbox(): CommandSandbox & { ran: string[] } {
  const ran: string[] = [];
  const result: BoundedResult = {
    code: 0,
    signal: null,
    stdout: "ok",
    stderr: "",
    timedOut: false,
  };
  return {
    ran,
    status: { state: "on", backend: "srt 0.0.81" },
    policy: () =>
      Promise.resolve({
        filesystem: { allowWrite: [], denyWrite: [], denyRead: [], allowRead: [] },
        mainCheckout: false,
      }),
    runShell: (command) => {
      ran.push(command);
      return Promise.resolve(result);
    },
    runArgv: (argv) => {
      ran.push(argv.join(" "));
      return Promise.resolve(result);
    },
  };
}

const bashCall = (command: string): CommandCall => ({
  commandId: "bash",
  callId: "c1",
  caller: { principalId: "model", principalType: "agent" },
  arguments: { command },
});

describe("approval on the sandboxed route", () => {
  it("a sandboxed bash call runs without a prompt under the operator posture on loopback", async () => {
    const bash = defineBash(base, { env: new MapEnv({}), sandbox: recordingSandbox() });
    const verdict = await bash.containment!.attest();
    assert.equal(verdict.status, "sandboxed");
    const result = evaluateCommandPolicy(bash, bashCall("npm test"), {
      permissionLevel: "operator",
      loopback: true,
      containment: verdict,
    });
    assert.deepEqual(result, { decision: "allow", authzBasis: "policy:allow:sandboxed" });
  });

  it("the strict posture still prompts for a sandboxed call", async () => {
    const bash = defineBash(base, { env: new MapEnv({}), sandbox: recordingSandbox() });
    const result = evaluateCommandPolicy(bash, bashCall("npm test"), {
      permissionLevel: "strict",
      loopback: true,
      containment: await bash.containment!.attest(),
    });
    assert.equal(result.decision, "ask");
  });

  it("a non-loopback turn still prompts for a sandboxed call", async () => {
    const bash = defineBash(base, { env: new MapEnv({}), sandbox: recordingSandbox() });
    const result = evaluateCommandPolicy(bash, bashCall("npm test"), {
      permissionLevel: "operator",
      loopback: false,
      containment: await bash.containment!.attest(),
    });
    assert.equal(result.decision, "ask");
  });

  it("a sandboxed git call runs without a prompt under the operator posture", async () => {
    const git = defineGit(base, { env: new MapEnv({}), sandbox: recordingSandbox() });
    const result = evaluateCommandPolicy(
      git,
      { ...bashCall(""), commandId: "git", arguments: { subcommand: "status" } },
      { permissionLevel: "operator", loopback: true, containment: await git.containment!.attest() },
    );
    assert.equal(result.authzBasis, "policy:allow:sandboxed");
  });

  it("the sandboxed bash runner sends the command to the sandbox, never to a native runner", async () => {
    const sandbox = recordingSandbox();
    let native = false;
    const bash = defineBash(base, {
      env: new MapEnv({}),
      sandbox,
      runner: () => {
        native = true;
        return Promise.reject(new Error("unreachable"));
      },
    });
    const out = await bash.executor(bashCall("echo hi"), { authzBasis: "policy:allow:sandboxed" });
    assert.deepEqual(sandbox.ran, ["echo hi"]);
    assert.equal(native, false);
    assert.match(String(out), /^exit 0\nok/);
  });
});

describe("DYFJ_SANDBOX=off", () => {
  it("bash takes the native prompting route: a call outside the read-only allowlist asks, never sandbox-allowed", async () => {
    const off = await bootSandbox({
      listenProbe: fakeListener, env: new MapEnv({ DYFJ_SANDBOX: "off" }) });
    let nativeRan = "";
    const bash = defineBash(base, {
      env: new MapEnv({}),
      sandbox: off,
      runner: (command) => {
        nativeRan = command;
        return Promise.resolve({ code: 0, signal: null, stdout: "", stderr: "", timedOut: false });
      },
    });
    assert.equal(bash.containment, undefined);
    for (const permissionLevel of ["operator", "strict"] as const) {
      const result = evaluateCommandPolicy(bash, bashCall("npm test"), {
        permissionLevel,
        loopback: true,
      });
      assert.equal(result.decision, "ask", permissionLevel);
      assert.notEqual(result.authzBasis, "policy:allow:sandboxed");
    }
    assert.match(bash.description, /NOT sandboxed/);
    // Once the operator approves, it runs on the native runner.
    await bash.executor(bashCall("npm test"), { authzBasis: "policy:allow:operator-approved" });
    assert.equal(nativeRan, "npm test");
  });

  it("an off sandbox refuses to run anything itself", async () => {
    const off = offSandbox("DYFJ_SANDBOX=off");
    await assert.rejects(
      off.runShell("true", { root: base, cwd: base, timeoutMs: 1000, env: {} }),
      /the sandbox is off/,
    );
  });
});

describe("the unsandboxed escape", () => {
  const escapeCall = (args: Record<string, unknown>): CommandCall => ({
    ...bashCall(""),
    arguments: { command: "npm run test:fast", unsandboxed: true, ...args },
  });

  function setup() {
    const sandbox = recordingSandbox();
    let nativeRan = "";
    const bash = defineBash(base, {
      env: new MapEnv({}),
      sandbox,
      runner: (command) => {
        nativeRan = command;
        return Promise.resolve({ code: 0, signal: null, stdout: "", stderr: "", timedOut: false });
      },
    });
    const registry = createCommandRegistry();
    registry.register(bash);
    const grants = new Set<string>();
    return { sandbox, bash, registry, grants, native: () => nativeRan };
  }

  it("always prompts, under the operator posture too, and is never granted for the session", async () => {
    const { registry, grants, sandbox, native } = setup();
    const prompts: { title: string; grantable?: boolean }[] = [];
    const approve = (request: { title: string; grantable?: boolean }) => {
      prompts.push(request);
      // Asks for the session scope; it must not stick.
      return Promise.resolve({ decision: "approve" as const, scope: "session" as const });
    };
    const context = { permissionLevel: "operator" as const, loopback: true, sessionGrants: grants };
    const call = escapeCall({ reason: "the gate's lane supervision runs ps" });
    for (let i = 0; i < 2; i++) {
      const result = await invokeCommand(registry, call, approve, context);
      assert.equal(result.decision, "allow");
      assert.equal(result.authzBasis, "policy:allow:operator-approved");
    }
    assert.equal(prompts.length, 2, "every unsandboxed call prompts");
    assert.equal(prompts.some((p) => p.grantable === true), false);
    assert.equal(grants.size, 0);
    // It ran on the native runner, not in the sandbox.
    assert.equal(native(), "npm run test:fast");
    assert.deepEqual(sandbox.ran, []);
  });

  it("is refused without a reason, before any prompt", async () => {
    const { registry } = setup();
    for (const args of [{}, { reason: "" }, { reason: "   " }]) {
      let asked = false;
      const result = await invokeCommand(
        registry,
        escapeCall(args),
        () => { asked = true; return Promise.resolve({ decision: "approve" as const }); },
        { permissionLevel: "operator", loopback: true },
      );
      assert.equal(result.decision, "deny");
      assert.equal(result.authzBasis, "policy:deny:unsandboxed-without-reason");
      assert.equal(asked, false);
    }
  });

  it("the approval prompt shows the reason", async () => {
    const { registry } = setup();
    let title = "";
    await invokeCommand(
      registry,
      escapeCall({ reason: "the gate's lane supervision runs ps" }),
      (request) => { title = request.title; return Promise.resolve({ decision: "deny" as const }); },
      { permissionLevel: "operator", loopback: true },
    );
    assert.match(title, /OUTSIDE THE SANDBOX, reason: the gate's lane supervision runs ps$/);
  });

  it("is refused where no operator can be asked", async () => {
    const { registry } = setup();
    const result = await invokeCommand(
      registry,
      escapeCall({ reason: "needs ps" }),
      () => Promise.resolve({ decision: "approve" as const }),
      { permissionLevel: "operator", loopback: false },
    );
    assert.equal(result.decision, "deny");
    assert.equal(result.authzBasis, "policy:deny:unsandboxed-headless");
  });

  it("the executor refuses an unsandboxed call that the operator did not approve", async () => {
    const { bash, native } = setup();
    const out = await bash.executor(escapeCall({ reason: "x" }), {
      authzBasis: "policy:allow:sandboxed",
    });
    assert.match(String(out), /^error: an unsandboxed command runs only with the operator's approval/);
    assert.equal(native(), "");
  });

  it("is offered only on the sandboxed route", () => {
    const native = defineBash(base, { env: new MapEnv({}) });
    assert.equal("unsandboxed" in (native.inputSchema.properties ?? {}), false);
  });
});
