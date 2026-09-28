// Test fake for the `DnsResolver` port (`src/tools/web/dns.ts`): answers from
// a per-host script and records every lookup it is asked for.
//
// A scripted host answers with its records for each type, and a type it does
// not list answers with no records, as does a host missing from the script.
// A host scripted as `"failed"` fails its lookups. A resolver built with
// `{ unavailable: true }` reports the resolver unavailable for every lookup.
// An aborted signal fails the lookup, which the real adapter reports before it
// checks its grant.

import type {
  DnsLookup,
  DnsRecordType,
  DnsResolver,
} from "../../src/tools/web/dns.ts";

export type ScriptedDnsHost =
  | { A?: readonly string[]; AAAA?: readonly string[] }
  | "failed";

export interface ScriptedDnsLookupCall {
  hostname: string;
  recordType: DnsRecordType;
}

export class ScriptedDnsResolver implements DnsResolver {
  readonly #hosts: ReadonlyMap<string, ScriptedDnsHost>;
  readonly #unavailable: boolean;
  readonly lookups: ScriptedDnsLookupCall[] = [];

  constructor(
    hosts: Readonly<Record<string, ScriptedDnsHost>> = {},
    options: { unavailable?: boolean } = {},
  ) {
    this.#hosts = new Map(Object.entries(hosts));
    this.#unavailable = options.unavailable === true;
  }

  resolve(
    hostname: string,
    recordType: DnsRecordType,
    signal?: AbortSignal,
  ): Promise<DnsLookup> {
    this.lookups.push({ hostname, recordType });
    if (signal?.aborted) {
      return Promise.resolve({ ok: false, reason: "failed" });
    }
    if (this.#unavailable) {
      return Promise.resolve({ ok: false, reason: "unavailable" });
    }
    const host = this.#hosts.get(hostname);
    if (host === "failed") {
      return Promise.resolve({ ok: false, reason: "failed" });
    }
    return Promise.resolve({
      ok: true,
      addresses: [...host?.[recordType] ?? []],
    });
  }
}
