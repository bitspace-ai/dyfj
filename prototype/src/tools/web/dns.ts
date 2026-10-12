/**
 * The `DnsResolver` port: the one way the web tools' address check (`web.ts`)
 * looks up a hostname's addresses.
 *
 * `systemDnsResolver` is the real adapter over a `node:dns` `Resolver`. Tests pass
 * the `ScriptedDnsResolver` fake from `testing/fakes/`, and both are held to
 * the conformance suite in `testing/conformance/dns-resolver.ts`.
 *
 * A lookup never throws: it returns either the resolver's answer or the reason
 * no answer was obtained, so the caller decides what an unverifiable target
 * means.
 */

import { Resolver } from "node:dns/promises";

export type DnsRecordType = "A" | "AAAA";

/** The outcome of one lookup. */
export type DnsLookup =
  /**
   * The resolver answered. `addresses` is empty when the name has no records
   * of the requested type, including when the name does not exist.
   */
  | { ok: true; addresses: readonly string[] }
  /**
   * No answer. `unavailable`: this process may not query a resolver or has
   * none. `failed`: the lookup was attempted or cancelled and did not produce
   * an answer.
   */
  | { ok: false; reason: "unavailable" | "failed" };

export interface DnsResolver {
  resolve(
    hostname: string,
    recordType: DnsRecordType,
    signal?: AbortSignal,
  ): Promise<DnsLookup>;
}

/** The part of a `node:dns/promises` `Resolver` the adapter uses. */
export interface NodeDnsResolver {
  getServers(): string[];
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
  cancel(): void;
}

/** Codes meaning the name does not exist or has no records of the type. */
const NO_RECORDS = new Set(["ENOTFOUND", "ENODATA"]);
/** Permission-error names meaning this process may not query a resolver. */
const DENIED_NAMES = new Set(["NotCapable", "PermissionDenied"]);
/** Permission-error codes meaning this process may not query a resolver. */
const DENIED_CODES = new Set(["ERR_ACCESS_DENIED", "EPERM"]);

/**
 * The real adapter over `make()`, a `node:dns` `Resolver` on the system's
 * default servers. Each lookup gets its own resolver, so an abort cancels only
 * that lookup.
 */
export function createSystemDnsResolver(
  make: () => NodeDnsResolver = () => new Resolver(),
): DnsResolver {
  return {
    async resolve(hostname, recordType, signal) {
      if (signal?.aborted) return { ok: false, reason: "failed" };
      let cancel: (() => void) | undefined;
      try {
        // Inside the try: under a runtime without the grant, constructing
        // the resolver can itself throw the permission error.
        const resolver = make();
        // Reading the default servers is the permission check: a lookup's own
        // error cannot tell an ungranted process from an unreachable server.
        if (resolver.getServers().length === 0) {
          return { ok: false, reason: "unavailable" };
        }
        cancel = () => resolver.cancel();
        signal?.addEventListener("abort", cancel, { once: true });
        const addresses = recordType === "A"
          ? await resolver.resolve4(hostname)
          : await resolver.resolve6(hostname);
        return { ok: true, addresses };
      } catch (err) {
        const { name, code } = err as { name?: unknown; code?: unknown };
        if (typeof code === "string" && NO_RECORDS.has(code)) {
          return { ok: true, addresses: [] };
        }
        if (
          (typeof name === "string" && DENIED_NAMES.has(name)) ||
          (typeof code === "string" && DENIED_CODES.has(code))
        ) {
          return { ok: false, reason: "unavailable" };
        }
        return { ok: false, reason: "failed" };
      } finally {
        if (cancel) signal?.removeEventListener("abort", cancel);
      }
    },
  };
}

/** The real adapter on the system's default servers. */
export const systemDnsResolver: DnsResolver = createSystemDnsResolver();
