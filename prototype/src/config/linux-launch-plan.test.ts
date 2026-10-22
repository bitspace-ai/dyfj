// The Linux launch plan: `compileLinux` output, a role template and the
// trusted installer's host resolution in, the bubblewrap arguments, Landlock
// paths and nftables ruleset the trusted launcher applies out. The plan is
// plain data; these tests pin its shape and its refusals. The module is loaded
// inside each test so that each test fails on its own until it exists.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { compileLinux, type LinuxOutput } from "./effective-policy-compile.ts";
import { parseEffectivePolicy } from "./effective-policy.ts";
import { policyDigest } from "./effective-policy-digest.ts";

const FIXTURE = fileURLToPath(
  new URL("../../testing/fixtures/effective-policy/", import.meta.url),
);

const planModule = () => import("./linux-launch-plan.ts");

function fixture(name: string): any {
  return JSON.parse(readFileSync(`${FIXTURE}${name}`, "utf8"));
}

/** The golden policy, edited by `edit`, re-sealed and compiled for Linux. */
function compiledWith(edit: (policy: any) => void): LinuxOutput {
  const policy = fixture("policy.json");
  edit(policy);
  policy.identity.digest = "";
  policy.identity.digest = policyDigest(policy);
  return compileLinux(parseEffectivePolicy(policy), fixture("target-linux.json"));
}

/**
 * The golden policy compiled for Linux, without its git-metadata protection,
 * which this target cannot enforce beneath a writable workspace.
 */
function compiled(): LinuxOutput {
  return compiledWith((policy) => {
    policy.filesystem.protectedGit = [];
  });
}

/** As `compiled`, with a firewall that accepts nothing: a no-network profile. */
function offline(): LinuxOutput {
  return compiledWith((policy) => {
    policy.filesystem.protectedGit = [];
    policy.network.entries = [];
    policy.network.dolt = null;
  });
}

function template(role: "runtime" | "executor"): any {
  return {
    role,
    uid: role === "runtime" ? 2001 : 2002,
    gid: role === "runtime" ? 2001 : 2002,
    systemReadOnly: ["/usr", "/etc/ld.so.cache"],
    symlinks: [{ link: "/bin", target: "usr/bin" }],
    helper: "/usr/libexec/dyfj/dyfj-sandbox",
  };
}

const RESOLVED = {
  "api.anthropic.com": ["192.0.2.80", "2001:db8::80"],
};

async function plan(output: unknown, role: any, resolved: unknown = RESOLVED) {
  const { planLinuxLaunch } = await planModule();
  return planLinuxLaunch(output as any, role, resolved as any);
}

async function refusal(output: unknown, role: any, resolved: unknown = RESOLVED) {
  const { LaunchPlanError } = await planModule();
  let thrown: unknown;
  let result: unknown;
  try {
    result = await plan(output, role, resolved);
  } catch (error) {
    thrown = error;
  }
  assert.strictEqual(result, undefined, "a refused plan returned output");
  assert.ok(thrown instanceof LaunchPlanError, String(thrown));
  return (thrown as any).offenders as { path: string; right: string }[];
}

describe("the runtime role", () => {
  it("shares the network namespace and unshares the rest", async () => {
    const result = await plan(compiled(), template("runtime"));
    assert.deepStrictEqual(result.bwrap.options.slice(0, 4), [
      "--unshare-all",
      "--unshare-user",
      "--share-net",
      "--disable-userns",
    ]);
  });

  it("builds the mount view from the template and the policy, in order", async () => {
    const result = await plan(compiled(), template("runtime"));
    assert.deepStrictEqual(result.bwrap.options.slice(4), [
      "--die-with-parent",
      "--new-session",
      "--cap-drop",
      "ALL",
      "--clearenv",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--ro-bind",
      "/usr",
      "/usr",
      "--ro-bind",
      "/etc/ld.so.cache",
      "/etc/ld.so.cache",
      "--symlink",
      "usr/bin",
      "/bin",
      "--bind",
      "/srv/work/space",
      "/run/dyfj/workspace",
      "--ro-bind",
      "/opt/toolchain",
      "/run/dyfj/toolchain",
      "--tmpfs",
      "/run/dyfj/scratch",
      "--chdir",
      "/run/dyfj/workspace",
    ]);
  });

  it("starts the helper inside the sandbox to apply Landlock before the command", async () => {
    const result = await plan(compiled(), template("runtime"));
    assert.deepStrictEqual(result.bwrap.inner, [
      "/usr/libexec/dyfj/dyfj-sandbox",
      "apply-landlock",
      JSON.stringify(result.landlock),
      "--",
    ]);
  });

  it("grants the template's read-only paths read, and the sandbox's own /proc and /dev", async () => {
    const result = await plan(compiled(), template("runtime"));
    assert.deepStrictEqual(result.landlock, {
      read: [
        "/usr",
        "/etc/ld.so.cache",
        "/proc",
        "/dev",
        "/run/dyfj/workspace",
        "/run/dyfj/toolchain",
        "/run/dyfj/scratch",
      ],
      write: ["/dev", "/run/dyfj/workspace", "/run/dyfj/scratch"],
      execute: ["/run/dyfj/toolchain"],
    });
  });

  it("names the writable mounts a command may start in", async () => {
    const result = await plan(compiled(), template("runtime"));
    assert.deepStrictEqual(result.writableTargets, [
      "/run/dyfj/workspace",
      "/run/dyfj/scratch",
    ]);
  });

  it("filters the runtime uid's egress to the resolved policy entries", async () => {
    const result = await plan(compiled(), template("runtime"));
    assert.strictEqual(
      result.nftables,
      [
        "table inet dyfj_runtime_2001",
        "delete table inet dyfj_runtime_2001",
        "table inet dyfj_runtime_2001 {",
        "  chain output {",
        "    type filter hook output priority filter; policy accept;",
        "    meta skuid 2001 jump role",
        "  }",
        "  chain role {",
        "    ct state established,related accept",
        "    ip daddr 192.0.2.80 tcp dport 443 accept",
        "    ip6 daddr 2001:db8::80 tcp dport 443 accept",
        "    ip daddr 192.0.2.10 tcp dport 3306 accept",
        "    ip daddr 192.0.2.53 udp dport 53 accept",
        "    ip daddr 192.0.2.10 tcp dport 8080 accept",
        '    meta l4proto tcp log prefix "dyfj-drop runtime " counter reject with tcp reset',
        '    log prefix "dyfj-drop runtime " counter reject with icmpx admin-prohibited',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("gives each uid its own table, so starting one role never replaces another's rules", async () => {
    const runtime = await plan(compiled(), template("runtime"));
    const cli = await plan(compiled(), { ...template("runtime"), uid: 2003 });
    const table = (text: string) => text.split("\n")[0];
    assert.notStrictEqual(table(runtime.nftables), table(cli.nftables));
    assert.ok(!cli.nftables.includes("dyfj_runtime_2001"));
  });

  it("carries the identity, digest, environment names and process limit", async () => {
    const output = compiled();
    const result = await plan(output, template("runtime"));
    assert.strictEqual(result.role, "runtime");
    assert.strictEqual(result.uid, 2001);
    assert.strictEqual(result.gid, 2001);
    assert.strictEqual(result.policyDigest, output.policyDigest);
    assert.deepStrictEqual(result.environment, ["PATH", "HOME", "DOLT_HOST"]);
    assert.strictEqual(result.maxProcesses, 64);
  });

  it("refuses a named host the installer did not resolve, naming no host", async () => {
    const offenders = await refusal(compiled(), template("runtime"), {});
    assert.deepStrictEqual(offenders, [
      { group: "network", path: "firewall.accept[0]", right: "host-unresolved" },
    ]);
  });

  it("refuses a resolved address that is not an address literal", async () => {
    const offenders = await refusal(compiled(), template("runtime"), {
      "api.anthropic.com": ["example"],
    });
    assert.deepStrictEqual(offenders, [
      { group: "network", path: "firewall.accept[0]", right: "address-invalid" },
    ]);
  });

  it("refuses an empty resolution rather than drop the entry silently", async () => {
    const offenders = await refusal(compiled(), template("runtime"), {
      "api.anthropic.com": [],
    });
    assert.deepStrictEqual(offenders, [
      { group: "network", path: "firewall.accept[0]", right: "host-unresolved" },
    ]);
  });
});

describe("the executor role", () => {
  it("unshares every namespace, the network included", async () => {
    const result = await plan(offline(), template("executor"));
    assert.deepStrictEqual(result.bwrap.options.slice(0, 3), [
      "--unshare-all",
      "--unshare-user",
      "--disable-userns",
    ]);
    assert.ok(!result.bwrap.options.includes("--share-net"));
  });

  it("refuses every packet its uid sends on the machine's own network", async () => {
    const result = await plan(offline(), template("executor"));
    assert.strictEqual(
      result.nftables,
      [
        "table inet dyfj_executor_2002",
        "delete table inet dyfj_executor_2002",
        "table inet dyfj_executor_2002 {",
        "  chain output {",
        "    type filter hook output priority filter; policy accept;",
        "    meta skuid 2002 jump role",
        "  }",
        "  chain role {",
        '    meta l4proto tcp log prefix "dyfj-drop executor " counter reject with tcp reset',
        '    log prefix "dyfj-drop executor " counter reject with icmpx admin-prohibited',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("refuses any network grant, which this target cannot give an executor", async () => {
    const offenders = await refusal(compiled(), template("executor"));
    assert.deepStrictEqual(
      offenders.map((o) => o.right),
      ["executor-network", "executor-network", "executor-network", "executor-network"],
    );
  });
});

describe("filesystem protections the plan cannot enforce", () => {
  it("refuses protected git metadata beneath a writable mount, rather than drop it", async () => {
    const output = compileLinux(
      parseEffectivePolicy(fixture("policy.json")),
      fixture("target-linux.json"),
    );
    const offenders = await refusal(output, template("runtime"));
    assert.deepStrictEqual(offenders, [
      { group: "filesystem", path: "protectedGit[0]", right: "protected-git-unsupported" },
      { group: "filesystem", path: "protectedGit[1]", right: "protected-git-unsupported" },
    ]);
  });

  it("refuses a forbidden path inside a mounted source", async () => {
    const output = compiledWith((policy) => {
      policy.filesystem.protectedGit = [];
      policy.network.entries = [];
      policy.network.dolt = null;
      policy.filesystem.forbiddenPaths = ["/srv/work/space/.env"];
    });
    const offenders = await refusal(output, template("executor"));
    assert.deepStrictEqual(offenders, [
      { group: "filesystem", path: "forbiddenPaths[0]", right: "forbidden-path-mounted" },
    ]);
  });

  it("refuses a forbidden path that contains a mounted source", async () => {
    const output = compiledWith((policy) => {
      policy.filesystem.protectedGit = [];
      policy.network.entries = [];
      policy.network.dolt = null;
      policy.filesystem.forbiddenPaths = ["/srv/work"];
    });
    const offenders = await refusal(output, template("executor"));
    assert.deepStrictEqual(offenders, [
      { group: "filesystem", path: "forbiddenPaths[0]", right: "forbidden-path-mounted" },
    ]);
  });

  it("refuses a forbidden path the template binds read-only", async () => {
    const output = compiledWith((policy) => {
      policy.filesystem.protectedGit = [];
      policy.network.entries = [];
      policy.network.dolt = null;
      policy.filesystem.forbiddenPaths = ["/etc/ld.so.cache"];
    });
    const offenders = await refusal(output, template("executor"));
    assert.deepStrictEqual(offenders, [
      { group: "filesystem", path: "forbiddenPaths[0]", right: "forbidden-path-mounted" },
    ]);
  });

  it("accepts a forbidden path that no mount reaches, which stays absent", async () => {
    const result = await plan(offline(), template("executor"));
    assert.ok(!result.bwrap.options.includes("/srv/secrets"));
    assert.ok(!result.bwrap.options.includes("/root/.ssh"));
  });

  it("accepts protected git metadata when the role writes nowhere", async () => {
    const output = compiledWith((policy) => {
      policy.network.entries = [];
      policy.network.dolt = null;
      policy.filesystem.scratch = null;
      policy.filesystem.roots = policy.filesystem.roots.map((root: any) => ({
        ...root,
        rights: root.rights.filter((right: string) => right !== "write"),
      }));
    });
    const result = await plan(output, template("executor"));
    assert.deepStrictEqual(result.writableTargets, []);
  });
});

describe("the command environment", () => {
  it("adds the template's command environment names after the policy's, once each", async () => {
    const result = await plan(offline(), {
      ...template("executor"),
      commandEnvironment: ["PATH", "GIT_CONFIG_COUNT", "PWD"],
    });
    assert.deepStrictEqual(result.environment, [
      "PATH",
      "HOME",
      "DOLT_HOST",
      "GIT_CONFIG_COUNT",
      "PWD",
    ]);
  });

  it("refuses a name that is not a plain environment name", async () => {
    const offenders = await refusal(offline(), {
      ...template("executor"),
      commandEnvironment: ["PATH", "A=B"],
    });
    assert.deepStrictEqual(offenders, [
      { group: "template", path: "template.commandEnvironment[1]", right: "name-invalid" },
    ]);
  });
});

describe("the template is checked", () => {
  for (const uid of [0, -1, 1.5, 65536 * 65536]) {
    it(`refuses uid ${uid}`, async () => {
      const offenders = await refusal(offline(), { ...template("executor"), uid });
      assert.deepStrictEqual(offenders, [
        { group: "template", path: "template.uid", right: "id-invalid" },
      ]);
    });
  }

  it("refuses gid 0", async () => {
    const offenders = await refusal(offline(), { ...template("executor"), gid: 0 });
    assert.deepStrictEqual(offenders, [
      { group: "template", path: "template.gid", right: "id-invalid" },
    ]);
  });

  it("refuses a role it does not know", async () => {
    const offenders = await refusal(offline(), { ...template("executor"), role: "root" });
    assert.deepStrictEqual(offenders, [
      { group: "template", path: "template.role", right: "role-invalid" },
    ]);
  });

  for (const path of ["usr", "/usr/../etc", "/usr/", "/"]) {
    it(`refuses a read-only path that is not canonical: ${JSON.stringify(path)}`, async () => {
      const offenders = await refusal(offline(), {
        ...template("executor"),
        systemReadOnly: [path],
        helper: "/usr/libexec/dyfj/dyfj-sandbox",
      });
      assert.ok(
        offenders.some((o) =>
          o.path === "template.systemReadOnly[0]" && o.right === "path-invalid"
        ),
        JSON.stringify(offenders),
      );
    });
  }

  it("refuses a helper outside every read-only path", async () => {
    const offenders = await refusal(offline(), {
      ...template("executor"),
      helper: "/var/tmp/dyfj-sandbox",
    });
    assert.deepStrictEqual(offenders, [
      { group: "template", path: "template.helper", right: "helper-not-read-only" },
    ]);
  });

  it("refuses a helper inside a writable policy mount", async () => {
    const offenders = await refusal(offline(), {
      ...template("executor"),
      systemReadOnly: ["/usr"],
      helper: "/run/dyfj/workspace/dyfj-sandbox",
    });
    assert.deepStrictEqual(offenders, [
      { group: "template", path: "template.helper", right: "helper-not-read-only" },
    ]);
  });

  it("refuses a template path that a policy mount also claims", async () => {
    const offenders = await refusal(offline(), {
      ...template("executor"),
      systemReadOnly: ["/usr", "/run/dyfj/workspace"],
    });
    assert.deepStrictEqual(offenders, [
      { group: "template", path: "template.systemReadOnly[1]", right: "mount-collides" },
    ]);
  });

  it("refuses a symlink whose target leaves the sandbox root", async () => {
    const offenders = await refusal(offline(), {
      ...template("executor"),
      symlinks: [{ link: "/bin", target: "../usr/bin" }],
    });
    assert.deepStrictEqual(offenders, [
      { group: "template", path: "template.symlinks[0]", right: "symlink-invalid" },
    ]);
  });

  it("refuses a seccomp profile it cannot install", async () => {
    const output: any = structuredClone(offline());
    output.process.seccompProfile = "standard-v1";
    const offenders = await refusal(output, template("executor"));
    assert.deepStrictEqual(offenders, [
      { group: "processes", path: "process.seccompProfile", right: "seccomp-unsupported" },
    ]);
  });

  it("reports every offender at once", async () => {
    const offenders = await refusal(compiled(), {
      ...template("executor"),
      uid: 0,
      helper: "/tmp/x",
    });
    assert.deepStrictEqual(offenders.map((o) => o.right), [
      "id-invalid",
      "helper-not-read-only",
      "executor-network",
      "executor-network",
      "executor-network",
      "executor-network",
    ]);
  });
});

describe("the plan is plain data", () => {
  it("survives a JSON round trip and repeats on every call", async () => {
    const first = await plan(compiled(), template("runtime"));
    const second = await plan(compiled(), template("runtime"));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(first)), first);
    assert.deepStrictEqual(first, second);
  });

  it("is frozen", async () => {
    const result = await plan(compiled(), template("runtime"));
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.bwrap.options));
    assert.ok(Object.isFrozen(result.landlock.read));
  });
});

describe("the module's source", () => {
  const source = () =>
    readFileSync(
      fileURLToPath(new URL("./linux-launch-plan.ts", import.meta.url)),
      "utf8",
    );

  it("holds no host or address literal", () => {
    assert.doesNotMatch(source(), /\b[0-9]{1,3}(?:\.[0-9]{1,3}){3}\b|::1|\blocalhost\b/);
  });

  it("opens no file and reads no clock, environment or randomness", () => {
    assert.doesNotMatch(
      source(),
      /node:fs|from "node:path"|process\.env|Date\.now|new Date\(|Math\.random/,
    );
  });
});
