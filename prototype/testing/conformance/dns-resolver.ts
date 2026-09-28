// Conformance suite for the `DnsResolver` port (`src/tools/web/dns.ts`).
//
// The `ScriptedDnsResolver` fake runs it in the unit lane in both modes. The
// real `systemDnsResolver` runs it in the integration lane in whichever mode
// the lane's net grant allows. Both must agree on what the web
// tools' address check relies on: a lookup never throws, an answer carries
// addresses of the requested family, a name that does not exist answers with
// no records, and a lookup that gets no answer says so instead of answering
// empty.

import { assert, assertEquals } from "@std/assert";
import type { DnsLookup, DnsResolver } from "../../src/tools/web/dns.ts";

/** A name that can never exist (RFC 6761 reserves `.invalid`). */
export const NONEXISTENT_HOST = "no-such-host.invalid";

export interface DnsResolverConformanceSubject {
  name: string;
  make(): DnsResolver;
  /**
   * `resolving`: lookups reach a resolver, and `resolvableHost` has at least
   * one A record. `ungranted`: the process may not query a resolver.
   */
  mode: "resolving" | "ungranted";
  resolvableHost: string;
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export function dnsResolverConformance(
  subject: DnsResolverConformanceSubject,
): void {
  const run = (
    label: string,
    body: (resolver: DnsResolver) => Promise<void>,
  ) => {
    Deno.test(
      `DnsResolver conformance (${subject.name}, ${subject.mode}): ${label}`,
      () => body(subject.make()),
    );
  };
  const host = subject.resolvableHost;

  run("an aborted lookup fails without an answer", async (resolver) => {
    const lookup = await resolver.resolve(host, "A", AbortSignal.abort());
    assertEquals(lookup, { ok: false, reason: "failed" });
  });

  if (subject.mode === "ungranted") {
    run("every lookup reports the resolver unavailable", async (resolver) => {
      const lookups: DnsLookup[] = await Promise.all([
        resolver.resolve(host, "A"),
        resolver.resolve(host, "AAAA"),
        resolver.resolve(NONEXISTENT_HOST, "A"),
      ]);
      for (const lookup of lookups) {
        assertEquals(lookup, { ok: false, reason: "unavailable" });
      }
    });
    return;
  }

  run("an A lookup answers with IPv4 addresses", async (resolver) => {
    const lookup = await resolver.resolve(host, "A");
    assert(lookup.ok, `lookup failed: ${JSON.stringify(lookup)}`);
    assert(lookup.addresses.length > 0, "expected at least one A record");
    for (const address of lookup.addresses) {
      assert(IPV4.test(address), `${address} is not an IPv4 address`);
    }
  });

  run("an AAAA answer holds only IPv6 addresses", async (resolver) => {
    const lookup = await resolver.resolve(host, "AAAA");
    assert(lookup.ok, `lookup failed: ${JSON.stringify(lookup)}`);
    for (const address of lookup.addresses) {
      assert(address.includes(":"), `${address} is not an IPv6 address`);
    }
  });

  run(
    "a name that does not exist answers with no records",
    async (resolver) => {
      assertEquals(await resolver.resolve(NONEXISTENT_HOST, "A"), {
        ok: true,
        addresses: [],
      });
    },
  );
}
