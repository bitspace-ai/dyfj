import { ScriptedDnsResolver } from "../../../testing/fakes/scripted-dns-resolver.ts";
import { dnsResolverConformance } from "../../../testing/conformance/dns-resolver.ts";

dnsResolverConformance({
  name: "ScriptedDnsResolver",
  mode: "resolving",
  resolvableHost: "example.com",
  make: () =>
    new ScriptedDnsResolver({
      "example.com": { A: ["93.184.216.34"], AAAA: ["2606:2800:220:1::"] },
    }),
});

dnsResolverConformance({
  name: "ScriptedDnsResolver",
  mode: "ungranted",
  resolvableHost: "example.com",
  make: () => new ScriptedDnsResolver({}, { unavailable: true }),
});
