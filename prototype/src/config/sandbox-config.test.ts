import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSandboxConfig } from "./sandbox-config.ts";

const PATH = ["", "cfg", "config.toml"].join("/");
const allow = (list: unknown[]) =>
  parseSandboxConfig({ sandbox: { allow_domains: list } }, PATH).allowDomains;
const deny = (list: unknown[]) =>
  parseSandboxConfig({ sandbox: { deny_read: list } }, PATH).denyRead;

describe("parseSandboxConfig", () => {
  it("is empty without a file or a [sandbox] table", () => {
    const none = { allowDomains: [], denyRead: [] };
    assert.deepStrictEqual(parseSandboxConfig(null, PATH), none);
    assert.deepStrictEqual(parseSandboxConfig({}, PATH), none);
    assert.deepStrictEqual(parseSandboxConfig({ sandbox: {} }, PATH), none);
  });

  it("allow_domains: normalizes, keeps one leading wildcard, drops duplicates", () => {
    assert.deepStrictEqual(
      allow(["Static.Crates.IO.", "*.pypi.org", "static.crates.io"]),
      ["static.crates.io", "*.pypi.org"],
    );
  });

  it("allow_domains: refuses a bare wildcard, a scheme, a port, a path or a non-string", () => {
    for (
      const bad of ["*", "*.org", "https://registry.npmjs.org", "registry.npmjs.org:443", "a.b/c", "a b", 7]
    ) {
      assert.throws(() => allow([bad]), /allow_domains entry 1/, String(bad));
    }
  });

  it("deny_read: takes home-relative and absolute paths, and a leading ~/", () => {
    assert.deepStrictEqual(
      deny([".example-tool/token", "~/.example-tool/token", "/srv/example/secret.json", ".other/"]),
      [".example-tool/token", "/srv/example/secret.json", ".other"],
    );
  });

  it("deny_read: refuses an empty path, the home or root itself, a .. segment, a control character or a non-string", () => {
    for (const bad of ["", "~", "/", "~/", "../escape", ".a/../../b", "a\nb", 7]) {
      assert.throws(() => deny([bad]), /deny_read entry 1/, JSON.stringify(bad));
    }
  });

  it("refuses an unknown key and a non-table", () => {
    assert.throws(
      () => parseSandboxConfig({ sandbox: { allow: [] } }, PATH),
      /unknown key in \[sandbox\]/,
    );
    assert.throws(
      () => parseSandboxConfig({ sandbox: [] }, PATH),
      /\[sandbox\] must be a table/,
    );
  });
});
