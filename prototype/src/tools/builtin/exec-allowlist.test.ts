import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { CommandCall } from "../definition.ts";
import { MapEnv } from "../../../testing/fakes/map-env.ts";
import { evaluateCommandPolicy } from "../policy.ts";
import { type BashRunner, defineBash, GIT_SAFETY_ENV, resolveBashCwd } from "./exec.ts";

let base = "";
let root = "";

before(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "exec-allowlist-")));
  root = join(base, "ws");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(base, "outside"));
  writeFileSync(join(root, "f"), "x\n");
  symlinkSync(join(base, "outside"), join(root, "out-link"));
});

after(() => rmSync(base, { recursive: true }));

const call = (args: Record<string, unknown>): CommandCall => ({
  commandId: "bash",
  callId: "c1",
  caller: { principalId: "model", principalType: "agent" },
  arguments: args,
});

interface Ran {
  command: string;
  cwd: string;
  env: Record<string, string>;
}

function recordingRunner(ran: Ran[]): BashRunner {
  return (command, cwd, _timeoutMs, env) => {
    ran.push({ command, cwd, env });
    return Promise.resolve({
      code: 0,
      signal: null,
      stdout: "ok",
      stderr: "",
      timedOut: false,
      termination: undefined,
    } as never);
  };
}

describe("resolveBashCwd", () => {
  it("defaults to the workspace root", () => {
    assert.deepEqual(resolveBashCwd(root, undefined), { cwd: root });
  });
  it("refuses an absolute path, even one inside the workspace", () => {
    assert.ok("error" in resolveBashCwd(root, join(root, "src")));
  });
  it("resolves a relative directory inside the workspace", () => {
    assert.deepEqual(resolveBashCwd(root, "src"), { cwd: join(root, "src") });
  });
  for (
    const [label, cwd] of [
      ["a parent escape", ".."],
      ["an absolute path outside", "/tmp"],
      ["a symlink to outside", "out-link"],
      ["a file", "f"],
      ["a missing directory", "nope"],
      ["an empty string", ""],
      ["a symlink then ..", "out-link/.."],
    ] as const
  ) {
    it(`refuses ${label}`, () => {
      const resolved = resolveBashCwd(root, cwd);
      assert.ok("error" in resolved, label);
    });
  }
});

describe("bash cwd argument", () => {
  it("runs the command in the given directory", async () => {
    const ran: Ran[] = [];
    const bash = defineBash(root, { runner: recordingRunner(ran) });
    await bash.executor(call({ command: "ls", cwd: "src" }), {
      authzBasis: "policy:allow:operator-approved",
    });
    assert.equal(ran[0].cwd, join(root, "src"));
  });

  it("refuses a cwd outside the workspace without running anything", async () => {
    const ran: Ran[] = [];
    const bash = defineBash(root, { runner: recordingRunner(ran) });
    const out = await bash.executor(call({ command: "ls", cwd: "/tmp" }), {
      authzBasis: "policy:allow:operator-approved",
    });
    assert.match(String(out), /^error: cwd/);
    assert.equal(ran.length, 0);
  });

  it("is declared in the schema", () => {
    const bash = defineBash(root);
    assert.equal(bash.inputSchema.properties?.cwd?.type, "string");
  });
});

describe("bash read-only allowlist in the policy", () => {
  const operator = { permissionLevel: "operator" as const, loopback: true };

  it("allows a read-only chain under the operator posture on loopback", () => {
    const verdict = evaluateCommandPolicy(
      defineBash(root),
      call({ command: 'cd "$PWD" && git status && git diff 2>&1 | head -50' }),
      operator,
    );
    assert.deepEqual(verdict, { decision: "allow", authzBasis: "policy:allow:bash-allowlist" });
  });

  it("classifies against the cwd argument", () => {
    const bash = defineBash(root);
    assert.equal(evaluateCommandPolicy(bash, call({ command: "cat ../f", cwd: "src" }), operator).decision, "allow");
    assert.equal(evaluateCommandPolicy(bash, call({ command: "cat ../f" }), operator).decision, "ask");
  });

  it("asks under strict", () => {
    const verdict = evaluateCommandPolicy(defineBash(root), call({ command: "git status" }), {
      permissionLevel: "strict",
      loopback: true,
    });
    assert.equal(verdict.decision, "ask");
  });

  it("asks off loopback", () => {
    const verdict = evaluateCommandPolicy(defineBash(root), call({ command: "git status" }), {
      permissionLevel: "operator",
      loopback: false,
    });
    assert.equal(verdict.decision, "ask");
  });

  it("asks for a command outside the allowlist", () => {
    for (const command of ["sed -i s/a/b/ f", "grep x f > out", "npm test"]) {
      assert.equal(evaluateCommandPolicy(defineBash(root), call({ command }), operator).decision, "ask", command);
    }
  });

  it("asks when the cwd argument is outside the workspace", () => {
    const verdict = evaluateCommandPolicy(defineBash(root), call({ command: "ls", cwd: "/tmp" }), operator);
    assert.equal(verdict.decision, "ask");
  });
});

describe("git config overrides on allowlisted calls", () => {
  it("an allowlisted call runs with the git safety environment", async () => {
    const ran: Ran[] = [];
    const bash = defineBash(root, { runner: recordingRunner(ran) });
    await bash.executor(call({ command: "git status" }), { authzBasis: "policy:allow:bash-allowlist" });
    for (const [key, value] of Object.entries(GIT_SAFETY_ENV)) {
      assert.equal(ran[0].env[key], value, key);
    }
  });

  it("an operator-approved call keeps the operator's git config", async () => {
    const ran: Ran[] = [];
    const bash = defineBash(root, { runner: recordingRunner(ran) });
    await bash.executor(call({ command: "git commit" }), { authzBasis: "policy:allow:operator-approved" });
    assert.equal(ran[0].env.GIT_CONFIG_COUNT, undefined);
  });
});

describe("bash's starting directory", () => {
  it("PWD and OLDPWD are the real cwd and CDPATH is absent, whatever the runtime inherited", async () => {
    const ran: Ran[] = [];
    const env = new MapEnv({
      PATH: "/usr/bin:/bin",
      PWD: join(root, "out-link"),
      OLDPWD: "/tmp",
      CDPATH: "/tmp",
    });
    const bash = defineBash(root, { runner: recordingRunner(ran), env });
    for (const authzBasis of ["policy:allow:bash-allowlist", "policy:allow:operator-approved"]) {
      await bash.executor(call({ command: "ls", cwd: "src" }), { authzBasis });
    }
    for (const run of ran) {
      assert.equal(run.env.PWD, join(root, "src"));
      assert.equal(run.env.OLDPWD, join(root, "src"));
      assert.equal("CDPATH" in run.env, false);
      assert.equal(run.env.PATH, "/usr/bin:/bin");
    }
  });
});
