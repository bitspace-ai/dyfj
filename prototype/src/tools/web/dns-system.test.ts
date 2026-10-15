// The real adapter's error mapping and abort handling, driven through
// `createSystemDnsResolver` with an injected stand-in for the `node:dns`
// `Resolver`. The adapter's answers against a real resolver are pinned by the
// conformance suite in `dns.integration.test.ts`.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSystemDnsResolver, type NodeDnsResolver } from "./dns.ts";

function codedError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function namedError(name: string): Error {
  const err = new Error(name);
  err.name = name;
  return err;
}

const SERVERS = ["192.0.2.53"];

/** A resolver whose every query rejects with `err`. */
function rejecting(err: Error): NodeDnsResolver {
  return {
    getServers: () => SERVERS,
    resolve4: () => Promise.reject(err),
    resolve6: () => Promise.reject(err),
    cancel: () => {},
  };
}

describe("createSystemDnsResolver", () => {
  it("answers an A lookup with resolve4 and an AAAA lookup with resolve6", async () => {
    const resolver = createSystemDnsResolver(() => ({
      getServers: () => SERVERS,
      resolve4: () => Promise.resolve(["192.0.2.1"]),
      resolve6: () => Promise.resolve(["2001:db8::1"]),
      cancel: () => {},
    }));
    assert.deepStrictEqual(await resolver.resolve("example.com", "A"), {
      ok: true,
      addresses: ["192.0.2.1"],
    });
    assert.deepStrictEqual(await resolver.resolve("example.com", "AAAA"), {
      ok: true,
      addresses: ["2001:db8::1"],
    });
  });

  for (const code of ["ENOTFOUND", "ENODATA"]) {
    it(`maps ${code} to an empty answer`, async () => {
      const resolver = createSystemDnsResolver(() =>
        rejecting(codedError(code))
      );
      assert.deepStrictEqual(await resolver.resolve("example.com", "A"), {
        ok: true,
        addresses: [],
      });
    });
  }

  for (
    const err of [namedError("NotCapable"), codedError("ERR_ACCESS_DENIED")]
  ) {
    const label = err.name === "Error"
      ? (err as { code?: string }).code
      : err.name;
    it(`maps ${label} to unavailable`, async () => {
      const resolver = createSystemDnsResolver(() => rejecting(err));
      assert.deepStrictEqual(await resolver.resolve("example.com", "A"), {
        ok: false,
        reason: "unavailable",
      });
    });
  }

  it("reports unavailable without a query when the servers cannot be read", async () => {
    let queried = 0;
    const resolver = createSystemDnsResolver(() => ({
      getServers: () => {
        throw namedError("NotCapable");
      },
      resolve4: () => (queried++, Promise.resolve([])),
      resolve6: () => (queried++, Promise.resolve([])),
      cancel: () => {},
    }));
    assert.deepStrictEqual(await resolver.resolve("example.com", "A"), {
      ok: false,
      reason: "unavailable",
    });
    assert.deepStrictEqual(queried, 0);
  });

  it("reports unavailable when there are no servers", async () => {
    const resolver = createSystemDnsResolver(() => ({
      getServers: () => [],
      resolve4: () => Promise.resolve(["192.0.2.1"]),
      resolve6: () => Promise.resolve([]),
      cancel: () => {},
    }));
    assert.deepStrictEqual(await resolver.resolve("example.com", "A"), {
      ok: false,
      reason: "unavailable",
    });
  });

  it("maps UNKNOWN to failed", async () => {
    const resolver = createSystemDnsResolver(() =>
      rejecting(codedError("UNKNOWN"))
    );
    assert.deepStrictEqual(await resolver.resolve("example.com", "A"), {
      ok: false,
      reason: "failed",
    });
  });

  it("makes no query for an already-aborted signal and fails", async () => {
    let made = 0;
    const resolver = createSystemDnsResolver(() => {
      made++;
      return rejecting(codedError("UNKNOWN"));
    });
    assert.deepStrictEqual(
      await resolver.resolve("example.com", "A", AbortSignal.abort()),
      { ok: false, reason: "failed" },
    );
    assert.deepStrictEqual(made, 0);
  });

  it("cancels the lookup when the signal aborts mid-lookup and fails", async () => {
    let cancelled = 0;
    let rejectQuery: (err: Error) => void = () => {};
    const controller = new AbortController();
    const resolver = createSystemDnsResolver(() => ({
      getServers: () => SERVERS,
      resolve4: () =>
        new Promise<string[]>((_, reject) => {
          rejectQuery = reject;
        }),
      resolve6: () => Promise.resolve([]),
      cancel: () => {
        cancelled++;
        rejectQuery(codedError("ECANCELLED"));
      },
    }));
    const lookup = resolver.resolve("example.com", "A", controller.signal);
    controller.abort();
    assert.deepStrictEqual(await lookup, { ok: false, reason: "failed" });
    assert.deepStrictEqual(cancelled, 1);
  });
});
