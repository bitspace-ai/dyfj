// The srt sandbox's policy, boot and approval routing (BIT-662), with srt and
// git faked. The real sandbox is exercised in `srt-sandbox.integration.test.ts`.

import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import packageJson from "../../../package.json" with { type: "json" };
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
  GIT_DIR_DENIED_NOTE,
  offSandbox,
  sandboxNetwork,
  SRT_BACKEND,
  type SrtLibrary,
} from "./srt-sandbox.ts";

let base = "";
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "srt-unit-")));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const layout = (value: GitLayout | null) => () => Promise.resolve(value);

it("names the pinned sandbox-runtime version", () => {
  assert.equal(SRT_BACKEND, `srt ${packageJson.dependencies["@anthropic-ai/sandbox-runtime"]}`);
});

/** A probe listener that never sees a connection. */
const fakeListener = () =>
  Promise.resolve({ port: 9, accepted: () => false, close: () => {} });

/** A probe listener that has already seen the control connection. */
const acceptingListener = () =>
  Promise.resolve({ port: 9, accepted: () => true, close: () => {} });

/**
 * A PATH whose `bash` exits 0 at once, for the boot tests that reach past the
 * probe's control connect. That step runs the real `bash` against the
 * listener's port, which needs a real listener, and a process in a sandbox
 * may not be allowed to listen. These tests are about what happens after the
 * control connect, so it is stood in for here; the failing control connect is
 * still exercised for real ("the probe fails when bash cannot connect ...").
 */
function pathWithConnectingBash(): string {
  const bin = join(base, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "bash"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`;
}

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
    assert.equal(policy.gitDirDenied, false);
    assert.deepEqual(policy.filesystem.allowWrite, [
      wt,
      join(common, "objects"),
      meta,
      join(common, "refs/heads/agent/session"),
      join(common, "refs/heads/agent/session.lock"),
      join(common, "logs/refs/heads/agent/session"),
    ]);
    // The shared config and the rest of the shared git dir are denied as well:
    // a definition of a diff, filter or textconv driver lives there, so it is
    // not something a sandboxed command may write.
    assert.deepEqual(policy.filesystem.denyWrite, [
      "/fake-home/.dyfj",
      join(common, "objects", "pack"),
      join(common, "objects", "info"),
      join(wt, ".git"),
      join(meta, "commondir"),
      join(meta, "gitdir"),
      join(meta, "config.worktree"),
      join(common, "config"),
      join(common, "config.worktree"),
      join(common, "hooks"),
      join(common, "info"),
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

  it("a main checkout on macOS denies host-execution, pointer and shared-integrity paths under .git", async () => {
    const gitDir = join(base, ".git");
    mkdirSync(gitDir);
    const policy = await compileWorkspacePolicy(base, {
      home: "/fake-home",
      platform: "darwin",
      readLayout: layout({
        gitDir,
        commonDir: gitDir,
        topLevel: base,
        branchRef: "refs/heads/main",
      }),
    });
    assert.equal(policy.gitDirDenied, false);
    assert.deepEqual(policy.filesystem.allowWrite, [base]);
    assert.deepEqual(policy.filesystem.denyWrite, [
      "/fake-home/.dyfj",
      join(gitDir, "config"),
      join(gitDir, "config.worktree"),
      join(gitDir, "commondir"),
      join(gitDir, "gitdir"),
      join(gitDir, "hooks"),
      join(gitDir, "info"),
      join(gitDir, "objects", "pack"),
      join(gitDir, "objects", "info"),
      join(gitDir, "packed-refs"),
      join(gitDir, "shallow"),
      join(gitDir, "worktrees"),
      join(gitDir, "refs", "remotes"),
      join(gitDir, "refs", "tags"),
      join(gitDir, "refs", "replace"),
    ]);
  });

  it("a main checkout on Linux write-denies the whole .git directory", async () => {
    const gitDir = join(base, ".git");
    mkdirSync(gitDir);
    const policy = await compileWorkspacePolicy(base, {
      home: "/fake-home",
      platform: "linux",
      readLayout: layout({
        gitDir,
        commonDir: gitDir,
        topLevel: base,
        branchRef: "refs/heads/main",
      }),
    });
    assert.equal(policy.gitDirDenied, true);
    assert.deepEqual(policy.filesystem.allowWrite, [base]);
    assert.deepEqual(policy.filesystem.denyWrite, ["/fake-home/.dyfj", gitDir]);
  });

  it("a directory outside any repository may write only itself", async () => {
    const policy = await compileWorkspacePolicy(base, { readLayout: layout(null) });
    assert.deepEqual(policy.filesystem.allowWrite, [base]);
    assert.deepEqual(policy.filesystem.denyWrite, [join(homedir(), ".dyfj")]);
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
    registerCommandNetworkLists: () => {},
    unregisterCommandNetworkLists: () => {},
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
      backend: SRT_BACKEND,
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
      listenProbe: acceptingListener,
      env: new MapEnv({ PATH: pathWithConnectingBash() }),
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

  it("the probe fails when bash cannot connect even outside the sandbox", async () => {
    // Nothing listens on the fake listener's port, so the control connect
    // fails, as it would for a bash without /dev/tcp; the sandbox's own
    // refusal would otherwise be indistinguishable from that.
    let wrapped = false;
    const sandbox = await bootSandbox({
      listenProbe: fakeListener,
      env: new MapEnv({ PATH: process.env.PATH ?? "/usr/bin:/bin" }),
      srt: fakeSrt({
        wrapWithSandbox: (command) => {
          wrapped = true;
          return Promise.resolve(`true; ${command}`);
        },
      }),
      scratchDir: join(base, "scratch"),
      readLayout: layout(null),
    });
    assert.match(
      (sandbox.status as { reason: string }).reason,
      /boot probe failed: the probe's control connect, outside the sandbox, did not succeed/,
    );
    assert.equal(wrapped, false);
  });

  it("denies reads of the runtime's directory when DYFJ_ROOT moves it", async () => {
    const elsewhere = join(base, "runtime-root");
    const denied: unknown[][] = [];
    await bootSandbox({
      listenProbe: acceptingListener,
      env: new MapEnv({
        PATH: pathWithConnectingBash(),
        DYFJ_ROOT: elsewhere,
      }),
      srt: fakeSrt({
        wrapWithSandbox: (command, _shell, config) => {
          denied.push([...(config.filesystem?.denyRead ?? [])]);
          return Promise.resolve(command);
        },
      }),
      scratchDir: join(base, "scratch"),
      readLayout: layout(null),
    });
    assert.ok(denied.length > 0, "the probe compiled a policy");
    assert.ok(denied[0]!.includes(elsewhere), JSON.stringify(denied[0]));
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
function recordingSandbox(
  opts: { gitDirDenied?: boolean; result?: Partial<BoundedResult> } = {},
): CommandSandbox & { ran: string[] } {
  const ran: string[] = [];
  const result: BoundedResult = {
    code: 0,
    signal: null,
    stdout: "ok",
    stderr: "",
    timedOut: false,
    ...opts.result,
  };
  return {
    ran,
    status: { state: "on", backend: "srt 0.0.81" },
    policy: () =>
      Promise.resolve({
        filesystem: { allowWrite: [], denyWrite: [], denyRead: [], allowRead: [] },
        gitDirDenied: opts.gitDirDenied ?? false,
        gitDirDeniedBy: opts.gitDirDenied === true ? "platform" : null,
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

  it("when gitDirDenied is true (Linux main checkout), git refuses add/commit with a clear note while status still runs", async () => {
    const sandbox = recordingSandbox({ gitDirDenied: true });
    const git = defineGit(base, { env: new MapEnv({}), sandbox });
    for (const args of [{ subcommand: "add", paths: ["a.txt"] }, { subcommand: "commit", message: "msg" }]) {
      const out = String(
        await git.executor(
          { ...bashCall(""), commandId: "git", arguments: args },
          { authzBasis: "policy:allow:sandboxed" },
        ),
      );
      assert.match(out, /^error: refusing to run git (add|commit) in the sandbox:/);
      assert.ok(out.includes(GIT_DIR_DENIED_NOTE.replace(/^note: /, "")), out);
    }
    assert.deepEqual(sandbox.ran, []);
    const status = String(
      await git.executor(
        { ...bashCall(""), commandId: "git", arguments: { subcommand: "status" } },
        { authzBasis: "policy:allow:sandboxed" },
      ),
    );
    assert.match(status, /^exit 0\nok/);
    assert.equal(sandbox.ran.length, 1);
  });

  it("when gitDirDenied is true (Linux main checkout), bash appends the note on a failed .git write", async () => {
    const sandbox = recordingSandbox({
      gitDirDenied: true,
      result: { code: 128, stdout: "", stderr: "fatal: Unable to create '/repo/.git/index.lock': Read-only file system" },
    });
    const bash = defineBash(base, { env: new MapEnv({}), sandbox });
    const out = String(await bash.executor(bashCall("git add a.txt"), { authzBasis: "policy:allow:sandboxed" }));
    assert.ok(out.includes(GIT_DIR_DENIED_NOTE), out);
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

/**
 * A PATH whose `bash` reports a `/dev/tcp` connect as succeeding and otherwise
 * runs the real bash: the probe's control connect passes, and its writes and
 * its sandboxed connect really happen.
 */
function pathWithProbeBash(): string {
  const bin = join(base, "bin-probe");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "bash"),
    `#!/bin/sh\ncase "$*" in *"/dev/tcp/"*) exit 0;; esac\nexec ${
      process.env.BASH_REAL ?? "/bin/bash"
    } "$@"\n`,
    { mode: 0o755 },
  );
  return `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`;
}

/**
 * The probe's two listeners: the first (its control connect, outside the
 * sandbox) has accepted, every later one (the sandboxed attempt) has not, so
 * the probe's own refusal check is the one under test.
 */
function probeListeners() {
  let calls = 0;
  return () =>
    Promise.resolve({
      port: 9,
      accepted: () => calls++ === 0,
      close: () => {},
    });
}

/**
 * A wrap that satisfies the boot probe and otherwise succeeds: the probe's
 * write outside its directory and its direct connect are refused, its write
 * inside runs.
 */
function probeSatisfyingWrap(command: string): Promise<string> {
  return Promise.resolve(
    command.includes("/dev/tcp/") || command.includes("outside")
      ? "exit 1"
      : `true; ${command}`,
  );
}

describe("per-workspace sandbox settings", () => {
  it("a workspace's allow_domains rides registerCommandNetworkLists, not the boot allowlist", async () => {
    const registered: { id: string; domains: string[] }[] = [];
    const unregistered: string[] = [];
    const wrapped: { id: string | undefined }[] = [];
    const sandbox = await bootSandbox({
      listenProbe: probeListeners(),
      env: new MapEnv({ PATH: pathWithProbeBash() }),
      srt: fakeSrt({
        wrapWithSandbox: (command, _shell, _config, _signal, options) => {
          wrapped.push({ id: options?.commandId });
          return probeSatisfyingWrap(command);
        },
        registerCommandNetworkLists: (id, lists) => {
          registered.push({ id, domains: [...(lists.allowedDomains ?? [])] });
        },
        unregisterCommandNetworkLists: (id) => {
          unregistered.push(id);
        },
      }),
      scratchDir: join(base, "scratch"),
      readLayout: layout(null),
      // A per-workspace extra domain, resolved by the runtime for the root the
      // run names.
      allowDomainsFor: (root) =>
        Promise.resolve(root === base ? ["static.crates.io"] : []),
    });
    assert.equal(sandbox.status.state, "on", JSON.stringify(sandbox.status));
    const probeCount = registered.length;
    await sandbox.runShell("true", {
      root: base,
      cwd: base,
      timeoutMs: 5_000,
      env: {},
    });
    const forRun = registered.slice(probeCount);
    assert.equal(forRun.length, 1, JSON.stringify(registered));
    assert.deepEqual(forRun[0]!.domains, ["static.crates.io"]);
    // The id is unguessable: at least 22 base64url characters.
    assert.match(forRun[0]!.id, /^[A-Za-z0-9_-]{22,}$/);
    assert.deepEqual(unregistered.slice(-1), [forRun[0]!.id]);
    assert.equal(wrapped.at(-1)?.id, forRun[0]!.id);
    // A second run gets a different id: the attribution key is per command.
    await sandbox.runShell("true", {
      root: base,
      cwd: base,
      timeoutMs: 5_000,
      env: {},
    });
    assert.notEqual(registered.at(-1)!.id, forRun[0]!.id);
    // Unless a run's own registration is withdrawn, it never widens another.
    assert.deepEqual(
      [...new Set(unregistered)].length,
      unregistered.length,
      "each registration is withdrawn once",
    );
  });

  it("a workspace with no extra domains registers nothing and passes no command id", async () => {
    let registrations = 0;
    const ids: (string | undefined)[] = [];
    const sandbox = await bootSandbox({
      listenProbe: probeListeners(),
      env: new MapEnv({ PATH: pathWithProbeBash() }),
      srt: fakeSrt({
        wrapWithSandbox: (command, _shell, _config, _signal, options) => {
          ids.push(options?.commandId);
          return probeSatisfyingWrap(command);
        },
        registerCommandNetworkLists: () => {
          registrations += 1;
        },
      }),
      scratchDir: join(base, "scratch"),
      readLayout: layout(null),
      allowDomainsFor: () => Promise.resolve([]),
    });
    assert.equal(sandbox.status.state, "on", JSON.stringify(sandbox.status));
    const before = registrations;
    ids.length = 0;
    await sandbox.runShell("true", { root: base, cwd: base, timeoutMs: 5_000, env: {} });
    assert.equal(registrations, before);
    assert.deepEqual(ids, [undefined]);
  });

  it("require_worktree write-denies the git directory of a main checkout", async () => {
    const gitDir = join(base, ".git");
    mkdirSync(gitDir);
    const mainLayout: GitLayout = {
      gitDir,
      commonDir: gitDir,
      topLevel: base,
      branchRef: "refs/heads/main",
    };
    const loose = await compileWorkspacePolicy(base, {
      home: "/fake-home",
      platform: "darwin",
      readLayout: layout(mainLayout),
    });
    const strict = await compileWorkspacePolicy(base, {
      home: "/fake-home",
      platform: "darwin",
      readLayout: layout(mainLayout),
      requireWorktree: true,
    });
    assert.equal(loose.gitDirDenied, false);
    assert.equal(strict.gitDirDenied, true);
    assert.ok(strict.filesystem.denyWrite.includes(gitDir), "the whole git dir is denied");
  });

  it("require_worktree leaves a linked worktree alone", async () => {
    const common = join(base, ".git");
    const wt = join(base, "wt");
    mkdirSync(common, { recursive: true });
    mkdirSync(wt);
    const policy = await compileWorkspacePolicy(wt, {
      home: "/fake-home",
      readLayout: layout({
        gitDir: join(common, "worktrees", "wt"),
        commonDir: common,
        topLevel: wt,
        branchRef: "refs/heads/agent/x",
      }),
      requireWorktree: true,
    });
    assert.equal(policy.gitDirDenied, false);
  });
});

describe("a restrictive workspace-policy lookup that fails", () => {
  /** A boot that gets past the probe, recording what the sandbox wrapped. */
  async function bootWithFailures(options: {
    requireWorktreeFor?: (root: string) => Promise<boolean>;
    denyReadFor?: (root: string) => Promise<readonly string[]>;
  }) {
    const wrapped: string[] = [];
    const sandbox = await bootSandbox({
      listenProbe: probeListeners(),
      env: new MapEnv({ PATH: pathWithProbeBash() }),
      srt: fakeSrt({
        wrapWithSandbox: (command) => {
          wrapped.push(command);
          return probeSatisfyingWrap(command);
        },
      }),
      scratchDir: join(base, "scratch"),
      readLayout: layout(null),
      ...options,
    });
    assert.equal(sandbox.status.state, "on", JSON.stringify(sandbox.status));
    return { sandbox, wrapped };
  }

  it("refuses the command when require_worktree cannot be resolved", async () => {
    const { sandbox, wrapped } = await bootWithFailures({
      // The probe compiles a policy in its own temporary root, so the failure
      // is this workspace's only: the boot succeeds and the run is refused.
      requireWorktreeFor: (root) =>
        root === base
          ? Promise.reject(new Error("the workspace profile could not be read"))
          : Promise.resolve(false),
    });
    const before = wrapped.length;
    await assert.rejects(
      () =>
        sandbox.runShell("true", {
          root: base,
          cwd: base,
          timeoutMs: 5_000,
          env: {},
        }),
      /the workspace profile could not be read/,
    );
    // No command was wrapped: the restriction was not silently dropped.
    assert.equal(wrapped.length, before);
  });

  it("refuses the command when a workspace's deny_read cannot be resolved", async () => {
    const { sandbox, wrapped } = await bootWithFailures({
      denyReadFor: (root) =>
        root === base
          ? Promise.reject(new Error("the workspace profile could not be read"))
          : Promise.resolve([]),
    });
    const before = wrapped.length;
    await assert.rejects(
      () =>
        sandbox.runShell("true", {
          root: base,
          cwd: base,
          timeoutMs: 5_000,
          env: {},
        }),
      /the workspace profile could not be read/,
    );
    // A deny that cannot be resolved never becomes a run without it.
    assert.equal(wrapped.length, before);
  });
});
