// The subset check: a session policy must sit inside its run envelope, group
// by group. `checkSessionWithinRun` lists every violation (a field path and a
// kind, never a value); `assertSessionWithinRun` throws them as one
// `PolicyEnvelopeError`. The run envelope here is the golden policy of
// `testing/fixtures/effective-policy`. The module is loaded inside each test
// so that each test fails (and is reported) on its own until it exists.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const FIXTURE = fileURLToPath(
  new URL("../../testing/fixtures/effective-policy/", import.meta.url),
);

const subsetModule = () => import("./effective-policy-subset.ts");

/** A fresh, mutable copy of the run envelope (the golden policy). */
function golden(): any {
  return JSON.parse(readFileSync(`${FIXTURE}policy.json`, "utf8"));
}

interface Violation {
  path: string;
  kind: string;
}

async function violations(session: unknown, run: unknown = golden()) {
  const { checkSessionWithinRun } = await subsetModule();
  return checkSessionWithinRun(session as any, run as any) as Violation[];
}

/** The groups that carry a violation: the first segment of each path. */
function groups(found: Violation[]): string[] {
  return [...new Set(found.map((violation) => violation.path.split(/[.\[]/)[0]))]
    .sort();
}

async function assertRejectedIn(group: string, session: unknown, run?: unknown) {
  const found = await violations(session, run);
  assert.ok(found.length > 0, `a session that breaks ${group} was accepted`);
  assert.deepStrictEqual(groups(found), [group]);
  for (const violation of found) {
    assert.strictEqual(typeof violation.path, "string");
    assert.ok(violation.path.length > 0);
    assert.strictEqual(typeof violation.kind, "string");
    assert.ok(violation.kind.length > 0);
  }
}

describe("a session within its run envelope", () => {
  it("accepts a session equal to the run envelope", async () => {
    assert.deepStrictEqual(await violations(golden()), []);
  });

  it("accepts a strictly narrower session in every group", async () => {
    const session = golden();
    session.identity.expiresAt = "2026-12-31T00:00:00.000Z";
    session.filesystem.roots = [
      {
        name: "workspace",
        source: "/srv/work/space/sub/dir",
        target: "workspace",
        rights: ["read"],
      },
    ];
    session.filesystem.forbiddenPaths.push("/srv/more");
    session.filesystem.protectedGit.push(".git/refs");
    session.network.entries = session.network.entries.slice(0, 1);
    session.network.brokerOperations = ["memory.search"];
    session.processes.executables = [session.processes.executables[0]];
    session.processes.descendants = false;
    session.processes.maxProcesses = 8;
    session.secrets = [session.secrets[0]];
    session.effects.tools = ["read_file"];
    session.effects.externalMutations = [];
    session.effects.limits = {
      timeMs: 60000,
      steps: 4,
      outputBytes: 1024,
      spendMicroUsd: { session: 0, perCall: 0, daily: 1000 },
    };
    assert.deepStrictEqual(await violations(session), []);
  });

  it("accepts a session with no roots, entries, secrets or tools", async () => {
    const session = golden();
    session.filesystem.roots = [];
    session.network.entries = [];
    session.network.brokerOperations = [];
    session.processes.executables = [];
    session.secrets = [];
    session.effects.tools = [];
    session.effects.externalMutations = [];
    assert.deepStrictEqual(await violations(session), []);
  });

  it("accepts a session in a different list order", async () => {
    const session = golden();
    session.network.entries.reverse();
    session.secrets.reverse();
    session.effects.tools.reverse();
    assert.deepStrictEqual(await violations(session), []);
  });

  it("accepts an equal or tighter posture, and any limit under an unbounded run limit", async () => {
    const run = golden();
    run.effects.approvalPosture = "operator";
    run.effects.paidRouting = true;
    run.effects.limits.spendMicroUsd.daily = null;
    run.effects.limits.timeMs = null;
    const session = golden();
    session.effects.approvalPosture = "strict";
    session.effects.paidRouting = false;
    session.effects.limits.spendMicroUsd.daily = 5000;
    session.effects.limits.timeMs = null;
    assert.deepStrictEqual(await violations(session, run), []);
  });
});

describe("assertSessionWithinRun", () => {
  it("returns for a session within its envelope", async () => {
    const { assertSessionWithinRun } = await subsetModule();
    assert.doesNotThrow(() => assertSessionWithinRun(golden(), golden()));
  });

  it("throws a PolicyEnvelopeError carrying every violation", async () => {
    const { assertSessionWithinRun, PolicyEnvelopeError } = await subsetModule();
    const session = golden();
    session.identity.job = "another-job";
    session.network.entries[0].port = 8443;
    session.effects.limits.steps = 1000;
    let thrown: unknown;
    try {
      assertSessionWithinRun(session, golden());
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof PolicyEnvelopeError);
    assert.ok(thrown instanceof Error);
    const list = (thrown as unknown as { violations: Violation[] }).violations;
    assert.deepStrictEqual(groups(list), ["effects", "identity", "network"]);
    assert.deepStrictEqual(
      list,
      await violations(session),
    );
  });
});

describe("identity", () => {
  it("rejects a different principal, job or run", async () => {
    for (const field of ["principal", "job", "run"]) {
      const session = golden();
      session.identity[field] = `${session.identity[field]}-other`;
      await assertRejectedIn("identity", session);
    }
  });

  it("rejects a different policy version", async () => {
    const session = golden();
    session.version = 2;
    const found = await violations(session);
    assert.ok(found.length > 0);
    assert.ok(groups(found).includes("version") || groups(found).includes("identity"));
  });

  it("rejects an expiry after the run's expiry, and accepts the same instant", async () => {
    const later = golden();
    later.identity.expiresAt = "2027-01-01T00:00:00.000Z";
    await assertRejectedIn("identity", later);
    const equal = golden();
    assert.deepStrictEqual(await violations(equal), []);
  });

  it("compares expiry as instants, not as text", async () => {
    const run = golden();
    run.identity.expiresAt = "2026-12-31T23:59:59.000Z";
    const sameInstant = golden();
    sameInstant.identity.expiresAt = "2027-01-01T01:59:59.000+02:00";
    assert.deepStrictEqual(await violations(sameInstant, run), []);
    const laterInstant = golden();
    laterInstant.identity.expiresAt = "2027-01-01T02:00:00.000+02:00";
    await assertRejectedIn("identity", laterInstant, run);
  });

  it("does not compare the two digests, which differ for any narrower session", async () => {
    const session = golden();
    session.identity.digest = "sha256:" + "1".repeat(64);
    assert.deepStrictEqual(await violations(session), []);
  });
});

describe("filesystem", () => {
  const root = (source: string, rights: string[] = ["read"], target = "workspace") => ({
    name: target,
    source,
    target,
    rights,
  });

  it("rejects a session root outside every run root", async () => {
    const session = golden();
    session.filesystem.roots = [root("/etc")];
    await assertRejectedIn("filesystem", session);
  });

  it("rejects a path-prefix lookalike of a run root", async () => {
    const run = golden();
    run.filesystem.roots = [root("/work", ["read", "write"])];
    for (const lookalike of ["/workspace", "/work-evil", "/work2/sub", "/wor"]) {
      const session = golden();
      session.filesystem.roots = [root(lookalike)];
      await assertRejectedIn("filesystem", session, run);
    }
    const inside = golden();
    inside.filesystem.roots = [root("/work/sub")];
    assert.deepStrictEqual(await violations(inside, run), []);
    const same = golden();
    same.filesystem.roots = [root("/work")];
    assert.deepStrictEqual(await violations(same, run), []);
  });

  it("rejects a dot component that would climb out of a run root", async () => {
    const session = golden();
    session.filesystem.roots = [root("/srv/work/space/../secrets")];
    await assertRejectedIn("filesystem", session);
    const dot = golden();
    dot.filesystem.roots = [root("/srv/work/space/./sub")];
    await assertRejectedIn("filesystem", dot);
  });

  it("rejects a relative session root", async () => {
    const session = golden();
    session.filesystem.roots = [root("srv/work/space")];
    await assertRejectedIn("filesystem", session);
  });

  it("rejects a root with a different target mount than the run root it sits under", async () => {
    const session = golden();
    session.filesystem.roots = [root("/srv/work/space", ["read"], "elsewhere")];
    await assertRejectedIn("filesystem", session);
  });

  it("rejects a right the run root does not grant", async () => {
    const session = golden();
    session.filesystem.roots = [root("/srv/work/space", ["read", "execute"])];
    await assertRejectedIn("filesystem", session);
    const exec = golden();
    exec.filesystem.roots = [root("/opt/toolchain", ["write"], "toolchain")];
    await assertRejectedIn("filesystem", exec);
  });

  it("rejects dropping a forbidden credential path, and accepts adding one", async () => {
    const session = golden();
    session.filesystem.forbiddenPaths = ["/srv/secrets"];
    await assertRejectedIn("filesystem", session);
    const none = golden();
    none.filesystem.forbiddenPaths = [];
    await assertRejectedIn("filesystem", none);
  });

  it("rejects dropping protected git metadata, and accepts adding some", async () => {
    const session = golden();
    session.filesystem.protectedGit = [".git/config"];
    await assertRejectedIn("filesystem", session);
    const none = golden();
    none.filesystem.protectedGit = [];
    await assertRejectedIn("filesystem", none);
  });
});

describe("network", () => {
  it("rejects an entry the run envelope does not list", async () => {
    const session = golden();
    session.network.entries.push({
      role: "provider",
      host: "api.example.test",
      port: 443,
      protocol: "tcp",
      dns: "none",
      hostnameAssurance: "tls",
    });
    await assertRejectedIn("network", session);
  });

  it("matches each field exactly: role, host, port, protocol and DNS", async () => {
    const changes: [string, unknown][] = [
      ["role", "local-model"],
      ["host", "api.anthropic.org"],
      ["port", 8443],
      ["protocol", "udp"],
      ["dns", "none"],
    ];
    for (const [field, value] of changes) {
      const session = golden();
      session.network.entries[0][field] = value;
      await assertRejectedIn("network", session);
    }
  });

  it("does not match by wildcard or host suffix", async () => {
    for (const host of ["*.anthropic.com", "*", "sub.api.anthropic.com", "anthropic.com", "api.anthropic.com.evil.test"]) {
      const session = golden();
      session.network.entries[0].host = host;
      await assertRejectedIn("network", session);
    }
  });

  it("does not treat a run wildcard as covering a named host", async () => {
    const run = golden();
    run.network.entries[0].host = "*.anthropic.com";
    const session = golden();
    session.network.entries[0].host = "api.anthropic.com";
    await assertRejectedIn("network", session, run);
  });

  it("rejects a broker operation the run envelope does not permit", async () => {
    const session = golden();
    session.network.brokerOperations.push("issues.delete");
    await assertRejectedIn("network", session);
  });
});

describe("processes", () => {
  it("rejects an executable the run envelope does not list", async () => {
    const session = golden();
    session.processes.executables.push({ program: "curl", role: "tool", digest: null });
    await assertRejectedIn("processes", session);
  });

  it("rejects a different digest, and a dropped digest, for a pinned executable", async () => {
    const other = golden();
    other.processes.executables[1].digest = "sha256:" + "cd".repeat(32);
    await assertRejectedIn("processes", other);
    const dropped = golden();
    dropped.processes.executables[1].digest = null;
    await assertRejectedIn("processes", dropped);
  });

  it("rejects the same program under another execution role", async () => {
    const session = golden();
    session.processes.executables[1].role = "runner";
    await assertRejectedIn("processes", session);
  });

  it("rejects descendants the run envelope does not allow", async () => {
    const run = golden();
    run.processes.descendants = false;
    const session = golden();
    session.processes.descendants = true;
    await assertRejectedIn("processes", session, run);
  });

  it("rejects a higher process count, and an unbounded one under a finite run count", async () => {
    const higher = golden();
    higher.processes.maxProcesses = 65;
    await assertRejectedIn("processes", higher);
    const unbounded = golden();
    unbounded.processes.maxProcesses = null;
    await assertRejectedIn("processes", unbounded);
  });

  it("accepts any count under an unbounded run count", async () => {
    const run = golden();
    run.processes.maxProcesses = null;
    const session = golden();
    session.processes.maxProcesses = 1000;
    assert.deepStrictEqual(await violations(session, run), []);
  });

  it("requires the same syscall profile when the run envelope names one", async () => {
    const run = golden();
    run.processes.syscallProfile = "standard-v1";
    const same = golden();
    same.processes.syscallProfile = "standard-v1";
    assert.deepStrictEqual(await violations(same, run), []);
    const none = golden();
    none.processes.syscallProfile = null;
    await assertRejectedIn("processes", none, run);
    const other = golden();
    other.processes.syscallProfile = "permissive-v1";
    await assertRejectedIn("processes", other, run);
  });
});

describe("secrets", () => {
  it("rejects a secret the run envelope does not name", async () => {
    const session = golden();
    session.secrets.push({ name: "OPENAI_API_KEY", owner: "provider" });
    await assertRejectedIn("secrets", session);
  });

  it("rejects the same secret under a different owning role", async () => {
    const session = golden();
    assert.strictEqual(session.secrets[0].owner, "dolt");
    session.secrets[0].owner = "provider";
    await assertRejectedIn("secrets", session);
  });

  it("rejects a wildcard secret", async () => {
    const session = golden();
    session.secrets.push({ name: "*", owner: "provider" });
    await assertRejectedIn("secrets", session);
  });
});

describe("effects and limits", () => {
  it("rejects a tool or external mutation the run envelope does not allow", async () => {
    const tool = golden();
    tool.effects.tools.push("run_checks");
    await assertRejectedIn("effects", tool);
    const mutation = golden();
    mutation.effects.externalMutations.push("issues.delete");
    await assertRejectedIn("effects", mutation);
  });

  it("rejects a looser approval posture", async () => {
    const session = golden();
    session.effects.approvalPosture = "operator";
    await assertRejectedIn("effects", session);
  });

  it("rejects paid routing the run envelope has off", async () => {
    const session = golden();
    session.effects.paidRouting = true;
    await assertRejectedIn("effects", session);
  });

  it("rejects each limit above the run's", async () => {
    const paths: [string[], number][] = [
      [["timeMs"], 3600001],
      [["steps"], 33],
      [["outputBytes"], 1048577],
      [["spendMicroUsd", "session"], 1000001],
      [["spendMicroUsd", "perCall"], 100001],
    ];
    for (const [path, value] of paths) {
      const session = golden();
      const parent = path.length === 1
        ? session.effects.limits
        : session.effects.limits[path[0]!];
      parent[path[path.length - 1]!] = value;
      await assertRejectedIn("effects", session);
    }
  });

  it("accepts a limit equal to the run's", async () => {
    const session = golden();
    session.effects.limits.steps = 32;
    session.effects.limits.spendMicroUsd.session = 1000000;
    assert.deepStrictEqual(await violations(session), []);
  });

  it("rejects a null (unbounded) session limit under a finite run limit", async () => {
    for (const path of [["timeMs"], ["steps"], ["outputBytes"], ["spendMicroUsd", "session"], ["spendMicroUsd", "perCall"]]) {
      const session = golden();
      const parent = path.length === 1
        ? session.effects.limits
        : session.effects.limits[path[0]!];
      parent[path[path.length - 1]!] = null;
      await assertRejectedIn("effects", session);
    }
    const daily = golden();
    const run = golden();
    run.effects.limits.spendMicroUsd.daily = 25_000_000;
    daily.effects.limits.spendMicroUsd.daily = null;
    await assertRejectedIn("effects", daily, run);
  });
});

describe("every violation is reported", () => {
  it("lists one violation per broken group, not just the first", async () => {
    const session = golden();
    session.identity.principal = "someone-else";
    session.filesystem.roots = [{
      name: "workspace",
      source: "/etc",
      target: "workspace",
      rights: ["read"],
    }];
    session.network.entries[0].port = 8443;
    session.processes.descendants = true;
    session.processes.maxProcesses = 1000;
    session.secrets[0].owner = "provider";
    session.effects.paidRouting = true;
    const run = golden();
    run.processes.descendants = false;
    const found = await violations(session, run);
    assert.deepStrictEqual(groups(found), [
      "effects",
      "filesystem",
      "identity",
      "network",
      "processes",
      "secrets",
    ]);
    assert.ok(found.filter((v) => v.path.startsWith("processes")).length >= 2);
  });

  it("leaves no URL path or query in a violation", async () => {
    const session = golden();
    session.secrets[0].owner = "provider";
    session.network.entries[0].host = "api.anthropic.com/v1/messages?key=abc";
    const found = await violations(session);
    const text = JSON.stringify(found);
    assert.ok(!text.includes("/v1/messages"));
    assert.ok(!text.includes("key=abc"));
  });
});

describe("the subset module's source", () => {
  it("opens no file and reads no clock, environment or randomness", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./effective-policy-subset.ts", import.meta.url)),
      "utf8",
    );
    assert.doesNotMatch(source, /node:fs|from "node:path"|process\.env|Date\.now|new Date\(\)|Math\.random/);
  });
});
