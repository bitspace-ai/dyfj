// Part B of the effective policy: the platform compilers. `compileKubernetes`
// and `compileLinux` turn a frozen effective policy and an explicit platform
// target into plain data, or refuse with `UnsupportedRightError` listing every
// offender. The compiled output is unverified against real platforms; these
// tests pin its shape, its parity with the code seams and its refusals. The
// module is loaded inside each test so that each test fails (and is reported)
// on its own until it exists.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  composeEffectivePolicy,
  parseEffectivePolicy,
  projectRuntimePolicy,
} from "./effective-policy.ts";
import { policyDigest } from "./effective-policy-digest.ts";
import { assertEgressAllowed } from "./egress.ts";
import type { McpHttpServerConfig } from "./mcp-servers.ts";
import type { SecretsConfig } from "./secrets-config.ts";
import { assertSpawnAllowed } from "./spawn-guard.ts";

const FIXTURE = fileURLToPath(
  new URL("../../testing/fixtures/effective-policy/", import.meta.url),
);

const compileModule = () => import("./effective-policy-compile.ts");

function fixture(name: string): any {
  return JSON.parse(readFileSync(`${FIXTURE}${name}`, "utf8"));
}

/** A fresh, mutable copy of the golden policy. */
function golden(): any {
  return fixture("policy.json");
}

/** `policy` with its digest recomputed and parsed, after a test edits it. */
function sealed(policy: any) {
  policy.identity.digest = "";
  policy.identity.digest = policyDigest(policy);
  return parseEffectivePolicy(policy);
}

type Platform = "kubernetes" | "linux";
const PLATFORMS: readonly Platform[] = ["kubernetes", "linux"];

function target(platform: Platform): any {
  return fixture(`target-${platform}.json`);
}

async function compile(platform: Platform, policy: unknown, input: unknown) {
  const { compileKubernetes, compileLinux } = await compileModule();
  return platform === "kubernetes"
    ? compileKubernetes(policy as any, input as any)
    : compileLinux(policy as any, input as any);
}

interface Offender {
  group: string;
  path: string;
  right: string;
}

/** The offenders `compile` refuses with; fails when it does not refuse. */
async function offenders(
  platform: Platform,
  policy: unknown,
  input: unknown,
): Promise<Offender[]> {
  const { UnsupportedRightError } = await compileModule();
  let output: unknown;
  let thrown: unknown;
  try {
    output = await compile(platform, policy, input);
  } catch (error) {
    thrown = error;
  }
  assert.strictEqual(output, undefined, "a refused compile returned output");
  assert.ok(thrown instanceof UnsupportedRightError, String(thrown));
  assert.strictEqual((thrown as any).platform, platform);
  return (thrown as any).offenders as Offender[];
}

async function assertRefused(
  platform: Platform,
  policy: unknown,
  input: unknown,
  expected: Offender,
) {
  const found = await offenders(platform, policy, input);
  assert.deepStrictEqual(found, [expected]);
}

describe("the golden policy compiles to the pinned output", () => {
  for (const platform of PLATFORMS) {
    it(`for ${platform}`, async () => {
      const output = await compile(
        platform,
        parseEffectivePolicy(golden()),
        target(platform),
      );
      assert.deepStrictEqual(output, fixture(`compiled-${platform}.json`));
    });
  }
});

describe("the compiled output is plain data", () => {
  for (const platform of PLATFORMS) {
    it(`survives a JSON round trip unchanged for ${platform}`, async () => {
      const output = await compile(
        platform,
        parseEffectivePolicy(golden()),
        target(platform),
      );
      assert.deepStrictEqual(JSON.parse(JSON.stringify(output)), output);
    });

    it(`is the same on every call and leaves its inputs unchanged for ${platform}`, async () => {
      const policy = parseEffectivePolicy(golden());
      const input = target(platform);
      const before = JSON.stringify(input);
      const first = await compile(platform, policy, input);
      const second = await compile(platform, policy, input);
      assert.deepStrictEqual(first, second);
      assert.strictEqual(JSON.stringify(input), before);
    });
  }
});

function server(url: string): McpHttpServerConfig {
  return { url } as McpHttpServerConfig;
}

const COMPOSED_INPUTS = {
  mcpServers: [server("https://mcp.example.test/mcp")],
  memoryMcpUrl: "http://127.0.0.1:7777/mcp",
  networkAllow: ["127.0.0.1:1234", "[::1]:9000", "api.example.test:8443"],
  nameserverGrants: ["192.0.2.53:53"],
  secrets: {
    command: ["/opt/bin/op"],
    inheritEnv: ["OP_SERVICE_ACCOUNT_TOKEN"],
  } as unknown as SecretsConfig,
  nodePath: "/opt/node/bin/node",
  runtimeExecutable: "/opt/runtime/bin/node",
  dolt: { host: "127.0.0.1", port: 3307 },
};

const ENVELOPE = {
  identity: {
    principal: "principal-01",
    job: "job-01",
    run: "run-01",
    repositories: ["repo-a"],
    expiresAt: "2026-12-31T23:59:59.000Z",
  },
};

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "[::1]" || host.startsWith("127.");
}

/** A target that maps every loopback entry of `net` to a named service. */
function mappingTarget(platform: Platform, net: readonly string[]): any {
  const input = target(platform);
  input.services = net
    .filter((entry) => isLoopback(entry.slice(0, entry.lastIndexOf(":"))))
    .map((entry, index) => ({
      entry,
      host: `svc-${index}.cluster.test`,
      port: Number(entry.slice(entry.lastIndexOf(":") + 1)),
    }));
  return input;
}

function compiledNet(platform: Platform, output: any): any[] {
  return platform === "kubernetes" ? output.egress : output.firewall.accept;
}

function compiledExecutables(platform: Platform, output: any): any[] {
  return platform === "kubernetes"
    ? output.executables
    : output.process.executables;
}

function egressUrl(entry: string): string {
  return entry.endsWith(":443") ? `https://${entry}/` : `http://${entry}/`;
}

describe("the compiled output agrees with the code seams", () => {
  for (const platform of PLATFORMS) {
    it(`lists exactly the seams' net entries for ${platform}`, async () => {
      const policy = composeEffectivePolicy(COMPOSED_INPUTS, ENVELOPE);
      const seams = projectRuntimePolicy(policy);
      const output = await compile(
        platform,
        policy,
        mappingTarget(platform, seams.net),
      );
      const compiled = compiledNet(platform, output).map((e) => e.policyEntry);
      assert.deepStrictEqual([...compiled].sort(), [...seams.net].sort());
      assert.strictEqual(new Set(compiled).size, compiled.length);
    });

    it(`admits each compiled net entry through the egress seam, and refuses one outside for ${platform}`, async () => {
      const policy = composeEffectivePolicy(COMPOSED_INPUTS, ENVELOPE);
      const seams = projectRuntimePolicy(policy);
      const output = await compile(
        platform,
        policy,
        mappingTarget(platform, seams.net),
      );
      for (const entry of compiledNet(platform, output)) {
        assert.doesNotThrow(
          () => assertEgressAllowed(seams, egressUrl(entry.policyEntry)),
          entry.policyEntry,
        );
      }
      assert.throws(() =>
        assertEgressAllowed(seams, "https://unlisted.example.test/")
      );
    });

    it(`admits each compiled executable through the spawn seam for ${platform}`, async () => {
      const policy = composeEffectivePolicy(COMPOSED_INPUTS, ENVELOPE);
      const seams = projectRuntimePolicy(policy);
      const output = await compile(
        platform,
        policy,
        mappingTarget(platform, seams.net),
      );
      const programs = compiledExecutables(platform, output).map((e) =>
        e.program
      );
      assert.deepStrictEqual(programs, [...seams.run]);
      for (const program of programs) {
        assert.doesNotThrow(() => assertSpawnAllowed(seams, program), program);
      }
      assert.deepStrictEqual(output.environment, [...seams.env]);
    });

    it(`maps the Dolt endpoint through the service map for ${platform}`, async () => {
      const policy = composeEffectivePolicy(COMPOSED_INPUTS, ENVELOPE);
      const seams = projectRuntimePolicy(policy);
      const input = mappingTarget(platform, seams.net);
      const output: any = await compile(platform, policy, input);
      const service = input.services.find((s: any) => s.entry === seams.dolt);
      assert.strictEqual(output.doltEndpoint, `${service.host}:${service.port}`);
    });
  }
});

describe("an unmapped loopback entry refuses", () => {
  for (const platform of PLATFORMS) {
    it(`for ${platform}, because it would point at the wrong database`, async () => {
      const input = target(platform);
      input.services = input.services.filter((s: any) =>
        s.entry !== "127.0.0.1:3306"
      );
      const found = await offenders(
        platform,
        parseEffectivePolicy(golden()),
        input,
      );
      assert.deepStrictEqual(found, [
        { group: "network", path: "network.entries[1]", right: "loopback-unmapped" },
        { group: "network", path: "network.dolt", right: "loopback-unmapped" },
      ]);
    });

    it(`names no host or address in the offenders for ${platform}`, async () => {
      const input = target(platform);
      input.services = [];
      const found = await offenders(
        platform,
        parseEffectivePolicy(golden()),
        input,
      );
      const text = JSON.stringify(found);
      assert.ok(!text.includes("127.0.0.1"));
      assert.ok(!text.includes("::1"));
    });
  }
});

describe("each unsupported right refuses", () => {
  for (const platform of PLATFORMS) {
    it(`tls hostname assurance without a gateway, on ${platform}`, async () => {
      const input = target(platform);
      input.capabilities.hostnameAssurances = ["none"];
      await assertRefused(platform, parseEffectivePolicy(golden()), input, {
        group: "network",
        path: "network.entries[0].hostnameAssurance",
        right: "tls",
      });
    });

    it(`a protocol the platform cannot filter, on ${platform}`, async () => {
      const input = target(platform);
      input.capabilities.protocols = ["tcp"];
      await assertRefused(platform, parseEffectivePolicy(golden()), input, {
        group: "network",
        path: "network.entries[2].protocol",
        right: "udp",
      });
    });

    it(`a named DNS resolver the platform cannot honour, on ${platform}`, async () => {
      const input = target(platform);
      input.capabilities.dnsModes = ["none"];
      await assertRefused(platform, parseEffectivePolicy(golden()), input, {
        group: "network",
        path: "network.entries[0].dns",
        right: "dns-resolver",
      });
    });

    it(`a filesystem right the platform cannot enforce, on ${platform}`, async () => {
      const input = target(platform);
      input.capabilities.filesystemRights = ["read", "write"];
      await assertRefused(platform, parseEffectivePolicy(golden()), input, {
        group: "filesystem",
        path: "filesystem.roots[1].rights",
        right: "execute",
      });
    });

    it(`an executable digest the platform cannot check, on ${platform}`, async () => {
      const input = target(platform);
      input.capabilities.executeByDigest = false;
      await assertRefused(platform, parseEffectivePolicy(golden()), input, {
        group: "processes",
        path: "processes.executables[1].digest",
        right: "execute-by-digest",
      });
    });

    it(`a null executable digest where the profile requires one, on ${platform}`, async () => {
      const input = target(platform);
      input.capabilities.requireExecutableDigest = true;
      await assertRefused(platform, parseEffectivePolicy(golden()), input, {
        group: "processes",
        path: "processes.executables[0].digest",
        right: "executable-digest-required",
      });
    });

    it(`a process count the platform cannot limit, on ${platform}`, async () => {
      const input = target(platform);
      input.capabilities.processLimit = false;
      await assertRefused(platform, parseEffectivePolicy(golden()), input, {
        group: "processes",
        path: "processes.maxProcesses",
        right: "process-limit",
      });
    });

    it(`a ban on descendants the platform cannot enforce, on ${platform}`, async () => {
      const policy = golden();
      policy.processes.descendants = false;
      const input = target(platform);
      input.capabilities.forbidDescendants = false;
      await assertRefused(platform, sealed(policy), input, {
        group: "processes",
        path: "processes.descendants",
        right: "no-descendants",
      });
    });

    it(`a syscall profile the platform does not have, on ${platform}`, async () => {
      const policy = golden();
      policy.processes.syscallProfile = "unknown-v9";
      await assertRefused(platform, sealed(policy), target(platform), {
        group: "processes",
        path: "processes.syscallProfile",
        right: "syscall-profile",
      });
    });

    it(`no syscall profile where the platform requires one, on ${platform}`, async () => {
      const input = target(platform);
      input.capabilities.requireSyscallProfile = true;
      await assertRefused(platform, parseEffectivePolicy(golden()), input, {
        group: "processes",
        path: "processes.syscallProfile",
        right: "syscall-profile-required",
      });
    });

    it(`two mounts on the same target, on ${platform}`, async () => {
      const policy = golden();
      policy.filesystem.roots[1].target = "workspace";
      const input = target(platform);
      if (platform === "kubernetes") {
        input.volumes = [{ source: "/", claim: "a" }];
      }
      await assertRefused(platform, sealed(policy), input, {
        group: "filesystem",
        path: "filesystem.roots[1].target",
        right: "mount-target-conflict",
      });
    });

    it(`a policy whose digest does not verify, on ${platform}`, async () => {
      const policy = golden();
      policy.effects.paidRouting = true;
      await assertRefused(platform, parseEffectivePolicy(policy), target(platform), {
        group: "identity",
        path: "identity.digest",
        right: "digest-mismatch",
      });
    });
  }

  it("a filesystem root with no volume on the cluster", async () => {
    const input = target("kubernetes");
    input.volumes = input.volumes.filter((v: any) => v.source !== "/opt");
    await assertRefused("kubernetes", parseEffectivePolicy(golden()), input, {
      group: "filesystem",
      path: "filesystem.roots[1]",
      right: "volume-unmapped",
    });
  });

  it("a named syscall profile compiles to a Localhost seccomp profile on the cluster", async () => {
    const policy = golden();
    policy.processes.syscallProfile = "standard-v1";
    const input = target("kubernetes");
    input.capabilities.syscallProfiles = ["standard-v1"];
    const output: any = await compile("kubernetes", sealed(policy), input);
    assert.deepStrictEqual(output.securityContext.seccompProfile, {
      type: "Localhost",
      localhostProfile: "standard-v1",
    });
  });
});

describe("the pre-gate cases", () => {
  it("mounts a narrower root at its sub-path in the claim that holds it", async () => {
    const policy = golden();
    policy.filesystem.roots[0].source = "/srv/work/space/sub/dir";
    const output: any = await compile("kubernetes", sealed(policy), target("kubernetes"));
    assert.deepStrictEqual(output.volumeMounts[0], {
      name: "workspace",
      mountPath: "/mnt/dyfj/workspace",
      subPath: "sub/dir",
      readOnly: false,
    });
  });

  it("mounts from the claim with the longest source that holds the root", async () => {
    const input = target("kubernetes");
    input.volumes.push({ source: "/opt/toolchain", claim: "exact" });
    const output: any = await compile("kubernetes", parseEffectivePolicy(golden()), input);
    assert.deepStrictEqual(output.volumes[1], {
      name: "toolchain",
      persistentVolumeClaim: { claimName: "exact" },
    });
    assert.strictEqual(output.volumeMounts[1].subPath, undefined);
  });

  it("refuses a root whose claim holds only a path-prefix lookalike", async () => {
    const input = target("kubernetes");
    input.volumes[0].source = "/srv/work/spa";
    await assertRefused("kubernetes", parseEffectivePolicy(golden()), input, {
      group: "filesystem",
      path: "filesystem.roots[0]",
      right: "volume-unmapped",
    });
  });

  for (const platform of PLATFORMS) {
    it(`refuses a mount target that is not one plain segment, on ${platform}`, async () => {
      for (const bad of ["../outside", "x/../workspace", ".", "..", "a/b", ""]) {
        const policy = golden();
        policy.filesystem.roots[1].target = bad === "" ? "-" : bad;
        const found = await offenders(platform, sealed(policy), target(platform));
        assert.deepStrictEqual(found, [{
          group: "filesystem",
          path: "filesystem.roots[1].target",
          right: "mount-target-invalid",
        }], bad);
      }
      const scratch = golden();
      scratch.filesystem.scratch = "../tmp";
      await assertRefused(platform, sealed(scratch), target(platform), {
        group: "filesystem",
        path: "filesystem.scratch",
        right: "mount-target-invalid",
      });
    });

    it(`refuses another spelling of a loopback host rather than compile it unmapped, on ${platform}`, async () => {
      for (const host of ["[0:0:0:0:0:0:0:1]", "127.1", "LOCALHOST", "localhost."]) {
        const policy = golden();
        policy.network.entries[3].host = host;
        const found = await offenders(platform, sealed(policy), target(platform));
        assert.deepStrictEqual(found, [{
          group: "network",
          path: "network.entries[3].host",
          right: "host-invalid",
        }], host);
      }
    });

    it(`refuses an unmapped loopback host in any canonical spelling, on ${platform}`, async () => {
      for (const host of ["[::]", "0.0.0.0", "127.0.0.2", "a.localhost", "[::ffff:7f00:1]"]) {
        const policy = golden();
        policy.network.entries[3].host = host;
        const found = await offenders(platform, sealed(policy), target(platform));
        assert.deepStrictEqual(found, [{
          group: "network",
          path: "network.entries[3]",
          right: "loopback-unmapped",
        }], host);
      }
    });

    it(`refuses a host that is neither an address nor a DNS name, on ${platform}`, async () => {
      const policy = golden();
      policy.network.entries[3].host = "[garbage]";
      await assertRefused(platform, sealed(policy), target(platform), {
        group: "network",
        path: "network.entries[3].host",
        right: "host-invalid",
      });
    });

    it(`refuses a service mapping to an invalid host, on ${platform}`, async () => {
      const input = target(platform);
      input.services[0].host = "not a host";
      const found = await offenders(platform, parseEffectivePolicy(golden()), input);
      assert.deepStrictEqual(found, [
        { group: "network", path: "network.entries[1]", right: "service-host-invalid" },
        { group: "network", path: "network.dolt", right: "service-host-invalid" },
      ]);
    });

    it(`refuses a service mapping to an impossible port, on ${platform}`, async () => {
      for (const port of [0, 70000, 1.5, NaN]) {
        const input = target(platform);
        input.services[1].port = port;
        await assertRefused(platform, parseEffectivePolicy(golden()), input, {
          group: "network",
          path: "network.entries[3]",
          right: "service-port-invalid",
        });
      }
    });

    it(`refuses a resolver mapping to an invalid host, on ${platform}`, async () => {
      const input = target(platform);
      input.services.push({ entry: "192.0.2.53:53", host: "not a host", port: 53 });
      const found = await offenders(platform, parseEffectivePolicy(golden()), input);
      assert.deepStrictEqual(found, [
        { group: "network", path: "network.entries[0].dns", right: "service-host-invalid" },
        { group: "network", path: "network.entries[2]", right: "service-host-invalid" },
      ]);
    });

    it(`refuses scratch storage on a target without write, on ${platform}`, async () => {
      const policy = golden();
      for (const root of policy.filesystem.roots) root.rights = ["read"];
      const input = target(platform);
      input.capabilities.filesystemRights = ["read"];
      await assertRefused(platform, sealed(policy), input, {
        group: "filesystem",
        path: "filesystem.scratch",
        right: "write",
      });
    });

    it(`leaves a writable root without execute out of the execute paths, on ${platform}`, async () => {
      const output: any = await compile(
        platform,
        parseEffectivePolicy(golden()),
        target(platform),
      );
      const workspace = platform === "kubernetes"
        ? "/mnt/dyfj/workspace"
        : "/run/dyfj/workspace";
      assert.ok(output.landlock.write.includes(workspace));
      assert.ok(!output.landlock.execute.includes(workspace));
    });

    it(`rewrites a mapped resolver in every entry that names it, on ${platform}`, async () => {
      const input = target(platform);
      input.services.push({ entry: "192.0.2.53:53", host: "198.51.100.53", port: 53 });
      const output: any = await compile(platform, parseEffectivePolicy(golden()), input);
      const net = compiledNet(platform, output);
      assert.strictEqual(net[0].dns, "resolver:198.51.100.53:53");
      assert.strictEqual(net[2].host, "198.51.100.53");
    });

    it(`refuses a Dolt endpoint that is not a canonical host and port, on ${platform}`, async () => {
      const policy = golden();
      policy.network.dolt = "bad host:3306";
      await assertRefused(platform, sealed(policy), target(platform), {
        group: "network",
        path: "network.dolt",
        right: "host-invalid",
      });
    });

    it(`refuses a resolver on an impossible port, on ${platform}`, async () => {
      const policy = golden();
      policy.network.entries[0].dns = "resolver:192.0.2.53:99999";
      await assertRefused(platform, sealed(policy), target(platform), {
        group: "network",
        path: "network.entries[0].dns",
        right: "host-invalid",
      });
    });

    it(`refuses a root source that is not a canonical absolute path, on ${platform}`, async () => {
      for (const source of ["relative/work", "/srv/work/../secrets", "/srv//work"]) {
        const policy = golden();
        policy.filesystem.roots[0].source = source;
        const input = target(platform);
        if (platform === "kubernetes") input.volumes.push({ source: "/", claim: "all" });
        const found = await offenders(platform, sealed(policy), input);
        assert.ok(
          found.some((o) =>
            o.path === "filesystem.roots[0].source" &&
            o.right === "source-not-canonical"
          ),
          source,
        );
      }
    });

    it(`refuses a loopback resolver with no mapping, on ${platform}`, async () => {
      const policy = golden();
      policy.network.entries[0].dns = "resolver:127.0.0.53:53";
      await assertRefused(platform, sealed(policy), target(platform), {
        group: "network",
        path: "network.entries[0].dns",
        right: "loopback-unmapped",
      });
    });
  }
});

describe("every offender is reported at once", () => {
  for (const platform of PLATFORMS) {
    it(`lists offenders from every group, in policy order, for ${platform}`, async () => {
      const input = target(platform);
      input.capabilities.hostnameAssurances = ["none"];
      input.capabilities.protocols = ["tcp"];
      input.capabilities.filesystemRights = ["read"];
      input.capabilities.processLimit = false;
      input.services = [];
      const found = await offenders(
        platform,
        parseEffectivePolicy(golden()),
        input,
      );
      assert.deepStrictEqual(found, [
        { group: "filesystem", path: "filesystem.roots[0].rights", right: "write" },
        { group: "filesystem", path: "filesystem.roots[1].rights", right: "execute" },
        { group: "filesystem", path: "filesystem.scratch", right: "write" },
        { group: "network", path: "network.entries[0].hostnameAssurance", right: "tls" },
        { group: "network", path: "network.entries[1]", right: "loopback-unmapped" },
        { group: "network", path: "network.entries[2].protocol", right: "udp" },
        { group: "network", path: "network.entries[3]", right: "loopback-unmapped" },
        { group: "network", path: "network.dolt", right: "loopback-unmapped" },
        { group: "processes", path: "processes.maxProcesses", right: "process-limit" },
      ]);
    });
  }

  it("carries the offenders on the error's message without values", async () => {
    const { UnsupportedRightError } = await compileModule();
    const input = target("linux");
    input.services = [];
    try {
      await compile("linux", parseEffectivePolicy(golden()), input);
      assert.fail("compile did not refuse");
    } catch (error) {
      assert.ok(error instanceof UnsupportedRightError);
      assert.ok(error instanceof Error);
      assert.match((error as Error).message, /network\.entries\[1\] \(loopback-unmapped\)/);
      assert.ok(!(error as Error).message.includes("127.0.0.1"));
    }
  });
});

describe("the new modules' source", () => {
  const MODULES = [
    "effective-policy.ts",
    "effective-policy-digest.ts",
    "effective-policy-subset.ts",
    "effective-policy-compile.ts",
  ];
  const HOST_LITERALS: readonly [string, RegExp][] = [
    ["an IPv4 address", /\b[0-9]{1,3}(?:\.[0-9]{1,3}){3}\b/],
    ["an IPv6 loopback", /::1/],
    // Kubernetes' `Localhost` seccomp type is not a host.
    ["localhost", /\blocalhost\b/],
    // In a string literal, so that a property access such as `runtime.net`
    // is not taken for a host name.
    [
      "a host name",
      /["'`][a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|ai|org|net|io|dev|test|internal|local|cluster)\b/i,
    ],
  ];

  for (const module of MODULES) {
    it(`holds no host literal: ${module}`, () => {
      const source = readFileSync(
        fileURLToPath(new URL(`./${module}`, import.meta.url)),
        "utf8",
      );
      for (const [label, pattern] of HOST_LITERALS) {
        assert.doesNotMatch(source, pattern, `${module} holds ${label}`);
      }
    });
  }

  it("opens no file and reads no clock, environment or randomness in the compiler", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./effective-policy-compile.ts", import.meta.url)),
      "utf8",
    );
    assert.doesNotMatch(
      source,
      /node:fs|from "node:path"|process\.env|Date\.now|new Date\(|Math\.random/,
    );
  });
});
