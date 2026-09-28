import { assertEquals, assertStringIncludes } from "@std/assert";
import { serveUnixNetFlag } from "./serve-unix-net-flag.ts";

function files(
  entries: Record<string, string>,
): (path: string) => Promise<string> {
  return (path) =>
    path in entries
      ? Promise.resolve(entries[path])
      : Promise.reject(new Deno.errors.NotFound(path));
}

const profile = JSON.stringify({
  permissions: {
    "serve-unix": { net: ["127.0.0.1:3306", "api.anthropic.com:443"] },
  },
});

Deno.test("serveUnixNetFlag appends the nameserver grants to the profile net list", async () => {
  assertEquals(
    await serveUnixNetFlag(files({
      "deno.json": profile,
      "/etc/resolv.conf": "nameserver 127.0.0.53\nnameserver 2001:db8::53\n",
    })),
    "--allow-net=127.0.0.1:3306,api.anthropic.com:443,127.0.0.53:53,[2001:db8::53]:53",
  );
});

Deno.test("serveUnixNetFlag repeats the profile list when no nameserver is readable", async () => {
  assertEquals(
    await serveUnixNetFlag(files({ "deno.json": profile })),
    "--allow-net=127.0.0.1:3306,api.anthropic.com:443",
  );
});

Deno.test("serveUnixNetFlag prints nothing when the profile net list is unusable", async () => {
  const resolv = { "/etc/resolv.conf": "nameserver 8.8.8.8\n" };
  for (
    const denoJson of [
      undefined,
      "not json",
      JSON.stringify({ permissions: {} }),
      JSON.stringify({ permissions: { "serve-unix": { net: [] } } }),
      JSON.stringify({ permissions: { "serve-unix": { net: true } } }),
      JSON.stringify({ permissions: { "serve-unix": { net: ["a:1,b:2"] } } }),
      JSON.stringify({ permissions: { "serve-unix": { net: ["a :1"] } } }),
    ]
  ) {
    const entries: Record<string, string> = denoJson === undefined
      ? resolv
      : { ...resolv, "deno.json": denoJson };
    assertEquals(await serveUnixNetFlag(files(entries)), "");
  }
});

Deno.test("the serve-unix task starts the engine with the printed flag", async () => {
  const tasks = JSON.parse(await Deno.readTextFile("deno.json")).tasks;
  assertStringIncludes(
    tasks["serve-unix"],
    "-P=serve-unix $(deno run --no-prompt --allow-read=deno.json,/etc/resolv.conf scripts/serve-unix-net-flag.ts) --env-file=.env src/server/main.ts",
  );
});
