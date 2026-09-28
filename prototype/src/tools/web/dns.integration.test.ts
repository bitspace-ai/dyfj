// The real `systemDnsResolver` against the `DnsResolver` conformance suite.
// The mode follows the lane's net grant: with unrestricted net the suite
// resolves a real name; otherwise every lookup must report the resolver
// unavailable.
import { systemDnsResolver } from "./dns.ts";
import { dnsResolverConformance } from "../../../testing/conformance/dns-resolver.ts";

dnsResolverConformance({
  name: "systemDnsResolver",
  mode: Deno.permissions.querySync({ name: "net" }).state === "granted"
    ? "resolving"
    : "ungranted",
  resolvableHost: "example.com",
  make: () => systemDnsResolver,
});
