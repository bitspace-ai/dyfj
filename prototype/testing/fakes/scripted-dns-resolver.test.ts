import assert from "node:assert/strict";
import { test } from "node:test";
import { ScriptedDnsResolver } from "./scripted-dns-resolver.ts";

test("ScriptedDnsResolver answers from its script and records lookups", async () => {
  const resolver = new ScriptedDnsResolver({
    "a.example": { A: ["192.0.2.1"] },
  });
  assert.deepStrictEqual(await resolver.resolve("a.example", "A"), {
    ok: true,
    addresses: ["192.0.2.1"],
  });
  assert.deepStrictEqual(await resolver.resolve("a.example", "AAAA"), {
    ok: true,
    addresses: [],
  });
  assert.deepStrictEqual(await resolver.resolve("unscripted.example", "A"), {
    ok: true,
    addresses: [],
  });
  assert.deepStrictEqual(resolver.lookups, [
    { hostname: "a.example", recordType: "A" },
    { hostname: "a.example", recordType: "AAAA" },
    { hostname: "unscripted.example", recordType: "A" },
  ]);
});

test("ScriptedDnsResolver fails a host scripted to fail", async () => {
  const resolver = new ScriptedDnsResolver({ "down.example": "failed" });
  assert.deepStrictEqual(await resolver.resolve("down.example", "A"), {
    ok: false,
    reason: "failed",
  });
});

test("an unavailable ScriptedDnsResolver answers nothing", async () => {
  const resolver = new ScriptedDnsResolver(
    { "a.example": { A: ["192.0.2.1"] } },
    { unavailable: true },
  );
  assert.deepStrictEqual(await resolver.resolve("a.example", "A"), {
    ok: false,
    reason: "unavailable",
  });
});
