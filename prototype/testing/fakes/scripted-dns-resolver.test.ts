import { assertEquals } from "@std/assert";
import { ScriptedDnsResolver } from "./scripted-dns-resolver.ts";

Deno.test("ScriptedDnsResolver answers from its script and records lookups", async () => {
  const resolver = new ScriptedDnsResolver({
    "a.example": { A: ["192.0.2.1"] },
  });
  assertEquals(await resolver.resolve("a.example", "A"), {
    ok: true,
    addresses: ["192.0.2.1"],
  });
  assertEquals(await resolver.resolve("a.example", "AAAA"), {
    ok: true,
    addresses: [],
  });
  assertEquals(await resolver.resolve("unscripted.example", "A"), {
    ok: true,
    addresses: [],
  });
  assertEquals(resolver.lookups, [
    { hostname: "a.example", recordType: "A" },
    { hostname: "a.example", recordType: "AAAA" },
    { hostname: "unscripted.example", recordType: "A" },
  ]);
});

Deno.test("ScriptedDnsResolver fails a host scripted to fail", async () => {
  const resolver = new ScriptedDnsResolver({ "down.example": "failed" });
  assertEquals(await resolver.resolve("down.example", "A"), {
    ok: false,
    reason: "failed",
  });
});

Deno.test("an unavailable ScriptedDnsResolver answers nothing", async () => {
  const resolver = new ScriptedDnsResolver(
    { "a.example": { A: ["192.0.2.1"] } },
    { unavailable: true },
  );
  assertEquals(await resolver.resolve("a.example", "A"), {
    ok: false,
    reason: "unavailable",
  });
});
