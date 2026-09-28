import { assertEquals } from "@std/assert";
import {
  nameserverNetGrants,
  readNameserverNetGrants,
  RESOLV_CONF_PATH,
} from "./nameservers.ts";

Deno.test("nameserverNetGrants grants port 53 on each IPv4 and IPv6 nameserver", () => {
  const conf = [
    "# generated",
    "search example.internal",
    "nameserver 127.0.0.53",
    "nameserver 8.8.8.8",
    "nameserver 2001:4860:4860::8888",
    "options edns0 trust-ad",
  ].join("\n");
  assertEquals(nameserverNetGrants(conf), [
    "127.0.0.53:53",
    "8.8.8.8:53",
    "[2001:4860:4860::8888]:53",
  ]);
});

Deno.test("nameserverNetGrants ignores comments, duplicates and malformed entries", () => {
  const conf = [
    "; nameserver 10.0.0.1",
    "nameserver 1.1.1.1 # primary",
    "  nameserver\t1.1.1.1",
    "nameserver 999.1.1.1",
    "nameserver resolver.example",
    "nameserver 1.2.3.4,5.6.7.8",
    "nameserver 9.9.9.9 extra",
    "nameserver",
    "nameservers 4.4.4.4",
  ].join("\n");
  assertEquals(nameserverNetGrants(conf), ["1.1.1.1:53"]);
});

Deno.test("nameserverNetGrants gives a malformed IPv6 nameserver no grant", () => {
  const conf = [
    "nameserver 2001:::1",
    "nameserver 1:2:3:4:5:6:7:8:9",
    "nameserver [2001:db8::1]",
    "nameserver 2001:DB8::53",
  ].join("\n");
  assertEquals(nameserverNetGrants(conf), ["[2001:db8::53]:53"]);
});

Deno.test("nameserverNetGrants gives a scoped IPv6 nameserver no grant", () => {
  assertEquals(
    nameserverNetGrants("nameserver fe80::1%eth0\nnameserver 9.9.9.9\n"),
    ["9.9.9.9:53"],
  );
});

Deno.test("readNameserverNetGrants reads the resolver configuration", async () => {
  const read: string[] = [];
  const grants = await readNameserverNetGrants((path) => {
    read.push(path);
    return Promise.resolve("nameserver 192.0.2.53\n");
  });
  assertEquals(read, [RESOLV_CONF_PATH]);
  assertEquals(grants, ["192.0.2.53:53"]);
});

Deno.test("readNameserverNetGrants yields no grants when the file cannot be read", async () => {
  assertEquals(
    await readNameserverNetGrants(() =>
      Promise.reject(new Deno.errors.NotFound("missing"))
    ),
    [],
  );
});
