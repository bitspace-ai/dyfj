import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { after, before, describe, it } from "node:test";
import {
  BEFORE_EXPIRY,
  executorPolicy,
} from "../../../testing/fakes/executor-policy.ts";
import { nodeSocketHost } from "../../transport/mod.ts";
import {
  checkAttestation,
  checkSocketOwnership,
  createContainment,
} from "./containment.ts";

const NONCE = "ab".repeat(16);
const INSTANCE = "cd".repeat(16);

function reply(edit: (r: any) => void = () => {}): any {
  const policy = executorPolicy();
  const r = {
    v: 2,
    nonce: NONCE,
    instance: INSTANCE,
    landlockAbi: 4,
    lease: "live",
    executorPolicy: policy,
    filesUnchanged: true,
    grant: policy.identity.digest,
    grantRefusal: null,
    probe: { passed: true, connect: "ENETUNREACH", write: "EROFS", ms: 80 },
  };
  edit(r);
  return r;
}

const check = (r: any) => checkAttestation(r, NONCE, BEFORE_EXPIRY, 120_000);

describe("containment attestation", () => {
  it("is attested and granted for a sound reply", () => {
    const verdict = check(reply());
    assert.strictEqual(verdict.status, "attested");
    assert.ok(verdict.status === "attested" && verdict.granted);
    assert.strictEqual(verdict.status === "attested" && verdict.envelope.instance, INSTANCE);
  });

  it("is attested but not granted when the grant is absent or names another digest", () => {
    for (const grant of [null, `sha256:${"9".repeat(64)}`]) {
      const verdict = check(reply((r) => (r.grant = grant)));
      assert.ok(verdict.status === "attested" && !verdict.granted, JSON.stringify(grant));
    }
  });

  for (
    const [label, edit, pattern] of [
      ["another nonce", (r: any) => (r.nonce = "ef".repeat(16)), /nonce/],
      ["no instance", (r: any) => delete r.instance, /instance/],
      ["an expired lease", (r: any) => (r.lease = "expired"), /lease/],
      ["changed files", (r: any) => (r.filesUnchanged = false), /changed/],
      ["a failed probe", (r: any) => (r.probe.passed = false), /probe/],
      ["no probe", (r: any) => delete r.probe, /probe/],
      ["no executor policy", (r: any) => (r.executorPolicy = null), /no executor policy/],
      ["a malformed policy", (r: any) => (r.executorPolicy = { version: 1 }), /malformed/],
      [
        "a policy whose digest does not verify",
        (r: any) => (r.executorPolicy.identity.run = "another-run"),
        /digest/,
      ],
      [
        "a policy with network access",
        (r: any) => {
          r.executorPolicy = executorPolicy((d) => (d.network.dolt = "127.0.0.1:3306"));
          r.grant = r.executorPolicy.identity.digest;
        },
        /network/,
      ],
    ] as const
  ) {
    it(`is unattested for ${label}`, () => {
      const verdict = check(reply(edit));
      assert.strictEqual(verdict.status, "unattested");
      assert.match(verdict.status === "unattested" ? verdict.reason : "", pattern);
    });
  }
});

describe("the containment of a tool", () => {
  let dir: string;
  let server: Server;
  let path: string;
  let answer: (nonce: string) => any = () => ({});

  before(async () => {
    dir = await mkdtemp("/tmp/dyfj-attest-");
    path = `${dir}/exec.sock`;
    server = createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const end = buffer.indexOf("\n");
        if (end === -1) return;
        const request = JSON.parse(buffer.slice(0, end));
        socket.end(`${JSON.stringify(answer(request.nonce))}\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(path, resolve));
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses a socket in a directory the runtime can write", async () => {
    assert.throws(() => checkSocketOwnership(path), /directory is writable|owned by the runtime/);
    const containment = createContainment(path, nodeSocketHost.connect, {
      defaultCommandTimeoutMs: 120_000,
      now: () => BEFORE_EXPIRY,
    });
    const verdict = await containment.attest();
    assert.strictEqual(verdict.status, "unattested");
  });

  it("attests through the supervisor with a fresh nonce", async () => {
    const seen: string[] = [];
    answer = (nonce) => {
      seen.push(nonce);
      return reply((r) => (r.nonce = nonce));
    };
    const containment = createContainment(path, nodeSocketHost.connect, {
      defaultCommandTimeoutMs: 120_000,
      checkSocket: () => {},
      now: () => BEFORE_EXPIRY,
    });
    assert.strictEqual((await containment.attest()).status, "attested");
    assert.strictEqual((await containment.attest()).status, "attested");
    assert.strictEqual(seen.length, 2);
    assert.notStrictEqual(seen[0], seen[1]);
  });

  it("is unattested for a version 1 supervisor", async () => {
    answer = (nonce) => ({ ...reply((r) => (r.nonce = nonce)), v: 1 });
    const containment = createContainment(path, nodeSocketHost.connect, {
      defaultCommandTimeoutMs: 120_000,
      checkSocket: () => {},
      now: () => BEFORE_EXPIRY,
    });
    const verdict = await containment.attest();
    assert.strictEqual(verdict.status, "unattested");
  });

  it("is unattested with no dialer or no supervisor", async () => {
    const none = createContainment(path, undefined, { defaultCommandTimeoutMs: 1 });
    assert.strictEqual((await none.attest()).status, "unattested");
    const absent = createContainment(`${dir}/absent.sock`, nodeSocketHost.connect, {
      defaultCommandTimeoutMs: 1,
      checkSocket: () => {},
    });
    const verdict = await absent.attest();
    assert.match(verdict.status === "unattested" ? verdict.reason : "", /executor unavailable/);
  });
});
