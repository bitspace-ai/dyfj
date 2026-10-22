// The isolated machine's installer: one composition of the runtime grants and
// the machine profile in; the run envelope, the three role policies (runtime,
// executor, CLI), their compiled Linux output, their launch plans and a
// receipt out. These tests pin the derivation and the receipt; the file and
// DNS work in `main` is exercised by the machine acceptance run.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkSessionWithinRun } from "../src/config/effective-policy-subset.ts";
import { GIT_COMMAND_ENV_KEYS } from "../src/tools/builtin/git.ts";

const installModule = () => import("./sandbox-install.ts");

function profile(): any {
  return {
    identity: {
      principal: "operator",
      job: "l8-attended",
      run: "run-0001",
      repositories: ["bitspace-ai/dyfj"],
      expiresAt: "2026-10-23T00:00:00Z",
    },
    workspace: "/srv/dyfj/work/run-0001",
    acceptAddressSet: ["api.anthropic.com:443"],
    runtime: { uid: 2001, gid: 2001 },
    executor: { uid: 2002, gid: 2002 },
    cli: {
      uid: 2003,
      gid: 2003,
      workspace: "/srv/dyfj/work/run-0001-cli",
      networkAllow: ["api.anthropic.com:443", "statsig.anthropic.com:443"],
    },
  };
}

const MACHINE = {
  nodePath: "/usr/local/bin/node",
  nameservers: ["192.0.2.53:53"],
  systemReadOnly: ["/etc/ld.so.cache", "/etc/passwd"],
};

const RESOLVED = {
  "api.anthropic.com": ["192.0.2.80"],
  "statsig.anthropic.com": ["192.0.2.81"],
};

async function build(overrides: Record<string, unknown> = {}) {
  const { buildMachinePlans } = await installModule();
  return buildMachinePlans({
    profile: profile(),
    machine: MACHINE,
    resolved: RESOLVED,
    ...overrides,
  } as any);
}

describe("the role policies", () => {
  it("are each within their run envelope", async () => {
    const result = await build();
    assert.deepStrictEqual(
      checkSessionWithinRun(result.runtime.policy, result.run),
      [],
    );
    assert.deepStrictEqual(
      checkSessionWithinRun(result.executor.policy, result.run),
      [],
    );
  });

  it("give the executor no network, no secrets and no database", async () => {
    const { executor } = await build();
    assert.deepStrictEqual(executor.policy.network.entries, []);
    assert.strictEqual(executor.policy.network.dolt, null);
    assert.deepStrictEqual(executor.policy.secrets, []);
    assert.deepStrictEqual(executor.plan.landlock.execute, ["/usr", "/work"]);
  });

  it("give the executor the bash and git tools' command environment", async () => {
    const { executor } = await build();
    for (const name of GIT_COMMAND_ENV_KEYS) {
      assert.ok(executor.plan.environment.includes(name), name);
    }
  });

  it("let the runtime write the workspace but not execute from it", async () => {
    const { runtime } = await build();
    assert.ok(runtime.plan.landlock.write.includes("/work"));
    assert.ok(!runtime.plan.landlock.execute.includes("/work"));
  });

  it("keep only the providers the profile accepts, and drop local models", async () => {
    const { runtime } = await build();
    const entries = runtime.policy.network.entries.map((e) =>
      `${e.role}:${e.host}:${e.port}`
    );
    assert.ok(entries.includes("provider:api.anthropic.com:443"));
    assert.ok(!entries.some((e) => e.startsWith("provider:api.openai.com")));
    assert.ok(!entries.some((e) => e.startsWith("local-model:")));
    assert.ok(entries.includes("dolt:127.0.0.1:3306"));
  });

  it("start the runtime with the executor socket's directory readable", async () => {
    const { runtime } = await build();
    assert.ok(runtime.plan.bwrap.options.includes("/run/dyfj-exec"));
  });
});

describe("git metadata", () => {
  it("carries no protection the target cannot enforce, in any envelope", async () => {
    const { run, cliRun, runtime, executor, cli } = await build();
    for (const policy of [run, cliRun, runtime.policy, executor.policy, cli.policy]) {
      assert.deepStrictEqual(policy.filesystem.protectedGit, []);
    }
  });

  it("keeps the CLI's workspace apart from the one the executor writes", async () => {
    const { executor, cli } = await build();
    const sources = (plan: any) =>
      plan.bwrap.options.flatMap((o: string, i: number, all: string[]) =>
        o === "--bind" ? [all[i + 1]] : []
      );
    assert.deepStrictEqual(sources(executor.plan), ["/srv/dyfj/work/run-0001"]);
    assert.deepStrictEqual(sources(cli.plan).filter((p: string) => p.startsWith("/srv/dyfj/work")), [
      "/srv/dyfj/work/run-0001-cli",
    ]);
  });

  it("refuses a CLI workspace that is, or lies within, the executor's", async () => {
    for (const workspace of ["/srv/dyfj/work/run-0001", "/srv/dyfj/work/run-0001/sub"]) {
      const p = profile();
      p.cli.workspace = workspace;
      await assert.rejects(build({ profile: p }), /CLI workspace/);
    }
  });
});

describe("the receipt", () => {
  it("records each role's digests and the enforced assurance beside the requested one", async () => {
    const { receipt, runtime, executor } = await build();
    assert.strictEqual(receipt.roles.runtime.policyDigest, runtime.policy.identity.digest);
    assert.strictEqual(receipt.roles.executor.policyDigest, executor.policy.identity.digest);
    assert.match(receipt.roles.runtime.planDigest, /^sha256:[0-9a-f]{64}$/);
    const provider = receipt.roles.runtime.egress.find((e: any) =>
      e.policyEntry === "api.anthropic.com:443"
    );
    assert.deepStrictEqual(provider, {
      policyEntry: "api.anthropic.com:443",
      protocol: "tcp",
      hostnameAssurance: "tls",
      enforcedAssurance: "address-set",
      addresses: ["192.0.2.80"],
    });
    assert.deepStrictEqual(receipt.roles.executor.egress, []);
  });

  it("names no secret value and no workspace content", async () => {
    const { receipt } = await build();
    assert.doesNotMatch(JSON.stringify(receipt), /canary|password|token/i);
  });
});

describe("refusals", () => {
  it("refuses two roles sharing a uid", async () => {
    const p = profile();
    p.executor.uid = p.runtime.uid;
    await assert.rejects(build({ profile: p }), /distinct uid/);
  });

  it("refuses a provider the profile accepts but the composition never granted", async () => {
    const p = profile();
    p.acceptAddressSet = ["example.invalid:443"];
    await assert.rejects(build({ profile: p }), /address-set-unknown/);
  });

  it("refuses an accepted host the installer could not resolve", async () => {
    await assert.rejects(build({ resolved: {} }), /host-unresolved/);
  });
});
