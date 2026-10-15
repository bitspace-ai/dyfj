// The real `systemDnsResolver` against the `DnsResolver` conformance suite.
//
// The suite's "resolving" cases query the system's real resolver, which is a
// third-party network service. The integration lane stays hermetic, so they
// run only when DYFJ_TEST_REAL_DNS=1 is set and are reported skipped
// otherwise. The lane does not pass the variable through; to run them, run
// this file directly:
//
//   DYFJ_TEST_REAL_DNS=1 node --test \
//     --import=./testing/node-handle-check.ts src/tools/web/dns.integration.test.ts
//
// Nothing sandboxes the resolver under `node --test`, so the suite's
// "ungranted" mode cannot be asserted against the real adapter here; its
// mapping of a denied lookup is pinned by `dns-system.test.ts` through
// injected errors. An ungranted real-adapter check can return once the
// product runs under Node's permission model.
import process from "node:process";
import { systemDnsResolver } from "./dns.ts";
import { dnsResolverConformance } from "../../../testing/conformance/dns-resolver.ts";

dnsResolverConformance({
  name: "systemDnsResolver",
  mode: "resolving",
  resolvableHost: "example.com",
  make: () => systemDnsResolver,
  skip: process.env.DYFJ_TEST_REAL_DNS === "1"
    ? undefined
    : "queries the real resolver; set DYFJ_TEST_REAL_DNS=1 to run",
});
