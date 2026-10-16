import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadNetworkAllow, parseNetworkAllow } from "./network-config.ts";

const PATH = ["", "cfg", "config.toml"].join("/");

describe("parseNetworkAllow", () => {
  it("is empty without a file or a [network] table", () => {
    assert.deepStrictEqual(parseNetworkAllow(null, PATH), []);
    assert.deepStrictEqual(parseNetworkAllow({}, PATH), []);
    assert.deepStrictEqual(parseNetworkAllow({ network: {} }, PATH), []);
  });

  it("normalizes hosts, keeps bracketed IPv6, and drops duplicates", () => {
    assert.deepStrictEqual(
      parseNetworkAllow(
        {
          network: {
            allow: [
              "127.0.0.1:1234",
              "LLM.Example.TEST.:8443",
              "[::1]:8080",
              "llm.example.test:8443",
            ],
          },
        },
        PATH,
      ),
      ["127.0.0.1:1234", "llm.example.test:8443", "[::1]:8080"],
    );
  });

  for (
    const [label, entry] of [
      ["no port", "127.0.0.1"],
      ["a scheme", "http://127.0.0.1:1234"],
      ["a path", "127.0.0.1:1234/v1"],
      ["a wildcard", "*.example.test:443"],
      ["a comma", "a.test:1,b.test:2"],
      ["whitespace", "a.test :443"],
      ["a zero port", "a.test:0"],
      ["a port above 65535", "a.test:65536"],
      ["an unbracketed IPv6 literal", "::1:8080"],
      ["an empty host", ":443"],
      ["credentials", "user@a.test:443"],
    ] as const
  ) {
    it(`fails config load on an entry with ${label}, naming the key and file`, () => {
      assert.throws(
        () => parseNetworkAllow({ network: { allow: [entry] } }, PATH),
        (error: unknown) =>
          error instanceof Error &&
          /\[network\] allow/.test(error.message) &&
          /config\.toml/.test(error.message) &&
          !error.message.includes("/cfg/"),
      );
    });
  }

  it("rejects a non-table section, a non-array list, a non-string entry and unknown keys", () => {
    for (
      const table of [
        { network: "x" },
        { network: { allow: "127.0.0.1:1" } },
        { network: { allow: [1] } },
        { network: { allows: [] } },
      ]
    ) {
      assert.throws(() => parseNetworkAllow(table, PATH), /\[network\]/);
    }
  });
});

describe("loadNetworkAllow", () => {
  it("reads [network] allow from the config file DYFJ_ROOT names", async () => {
    const allow = await loadNetworkAllow({
      env: { get: (name) => (name === "DYFJ_ROOT" ? "/cfg" : undefined) },
      readTextFile: (path) => {
        assert.strictEqual(path, PATH);
        return Promise.resolve("ignored");
      },
      parseToml: () => ({ network: { allow: ["127.0.0.1:1234"] } }),
    });
    assert.deepStrictEqual(allow, ["127.0.0.1:1234"]);
  });
});
