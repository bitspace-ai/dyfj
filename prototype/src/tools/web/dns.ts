/**
 * The `DnsResolver` port: the one way the web tools' address check (`web.ts`)
 * looks up a hostname's addresses.
 *
 * `systemDnsResolver` is the real adapter over `Deno.resolveDns`. Tests pass
 * the `ScriptedDnsResolver` fake from `testing/fakes/`, and both are held to
 * the conformance suite in `testing/conformance/dns-resolver.ts`.
 *
 * A lookup never throws: it returns either the resolver's answer or the reason
 * no answer was obtained, so the caller decides what an unverifiable target
 * means.
 */

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

type ResolveDns = (
  hostname: string,
  recordType: DnsRecordType,
  options?: { signal?: AbortSignal },
) => Promise<string[]>;

/** The real adapter: the platform resolver, through `Deno.resolveDns`. */
export const systemDnsResolver: DnsResolver = {
  async resolve(hostname, recordType, signal) {
    const resolveDns = (globalThis as { Deno?: { resolveDns?: ResolveDns } })
      .Deno?.resolveDns;
    if (typeof resolveDns !== "function") {
      return { ok: false, reason: "unavailable" };
    }
    try {
      const addresses = await resolveDns(
        hostname,
        recordType,
        signal === undefined ? undefined : { signal },
      );
      return { ok: true, addresses };
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        return { ok: true, addresses: [] };
      }
      if (
        err instanceof Deno.errors.NotCapable ||
        err instanceof Deno.errors.PermissionDenied
      ) {
        return { ok: false, reason: "unavailable" };
      }
      return { ok: false, reason: "failed" };
    }
  },
};
