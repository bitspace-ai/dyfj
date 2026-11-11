import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { MapEnv } from "../../testing/fakes/map-env.ts";
import {
  DEFAULT_DISPATCH_MAX_CHILDREN,
  DEFAULT_DISPATCH_MAX_WAIT_SECONDS,
  loadDispatchConfig,
  MAX_DISPATCH_CONFIG_ROOTS,
  MAX_DISPATCH_MAX_CHILDREN,
  MAX_DISPATCH_MAX_WAIT_SECONDS,
  parseDispatchConfig,
} from "./dispatch-config.ts";

const WHERE = "/fixture/config.toml";

function table(dispatch: Record<string, unknown>): Record<string, unknown> {
  return { dispatch };
}

describe("dispatch config: an absent table", () => {
  it("returns null so no dispatch/* tool is registered", () => {
    assert.strictEqual(parseDispatchConfig(null, WHERE), null);
    assert.strictEqual(parseDispatchConfig({}, WHERE), null);
  });

  it("loadDispatchConfig returns null when the config file does not exist", async () => {
    const loaded = await loadDispatchConfig({
      env: new MapEnv({ HOME: "/fixture/operator" }),
      readTextFile: () =>
        Promise.reject(Object.assign(new Error("gone"), { code: "ENOENT" })),
      parseToml: () => ({}),
    });
    assert.strictEqual(loaded, null);
  });
});

describe("dispatch config: valid [dispatch] tables", () => {
  it("parses roots with default max_children and max_wait_seconds", () => {
    const env = new MapEnv({ HOME: "/fixture/operator" });
    const parsed = parseDispatchConfig(
      table({ roots: ["~/worktrees", "/tmp/worktrees"] }),
      WHERE,
      env,
    );
    assert.ok(parsed !== null);
    assert.strictEqual(parsed.maxChildren, DEFAULT_DISPATCH_MAX_CHILDREN);
    assert.strictEqual(parsed.maxWaitSeconds, DEFAULT_DISPATCH_MAX_WAIT_SECONDS);
    assert.deepStrictEqual(parsed.roots, [
      resolve("/fixture/operator/worktrees"),
      resolve("/tmp/worktrees"),
    ]);
  });

  it("parses explicit max_children, max_wait_seconds, and bare ~ root", () => {
    const env = new MapEnv({ HOME: "/fixture/operator" });
    const parsed = parseDispatchConfig(
      table({
        max_children: 5,
        max_wait_seconds: 120,
        roots: ["~"],
      }),
      WHERE,
      env,
    );
    assert.ok(parsed !== null);
    assert.strictEqual(parsed.maxChildren, 5);
    assert.strictEqual(parsed.maxWaitSeconds, 120);
    assert.deepStrictEqual(parsed.roots, [resolve("/fixture/operator")]);
  });
});

describe("dispatch config: invalid [dispatch] tables", () => {
  it("refuses a non-table section", () => {
    assert.throws(
      () => parseDispatchConfig({ dispatch: "nope" }, WHERE),
      /\[dispatch\] must be a table/,
    );
    assert.throws(
      () => parseDispatchConfig({ dispatch: [] }, WHERE),
      /\[dispatch\] must be a table/,
    );
  });

  it("refuses unknown keys including depth", () => {
    assert.throws(
      () =>
        parseDispatchConfig(
          table({ roots: ["/tmp/worktrees"], depth: 2 }),
          WHERE,
        ),
      /unknown key dispatch\.depth/,
    );
    assert.throws(
      () =>
        parseDispatchConfig(
          table({ roots: ["/tmp/worktrees"], close_idle_minutes: 10 }),
          WHERE,
        ),
      /unknown key dispatch\.close_idle_minutes/,
    );
  });

  it("requires roots and refuses empty, relative, traversal, or control-character roots", () => {
    assert.throws(
      () => parseDispatchConfig(table({ max_children: 3 }), WHERE),
      /dispatch\.roots is required/,
    );
    assert.throws(
      () => parseDispatchConfig(table({ roots: "not-an-array" }), WHERE),
      /dispatch\.roots must be an array/,
    );
    assert.throws(
      () => parseDispatchConfig(table({ roots: [] }), WHERE),
      /dispatch\.roots must not be empty/,
    );
    assert.throws(
      () =>
        parseDispatchConfig(
          table({
            roots: Array.from(
              { length: MAX_DISPATCH_CONFIG_ROOTS + 1 },
              (_, i) => `/tmp/r-${i}`,
            ),
          }),
          WHERE,
        ),
      /the limit is/,
    );
    assert.throws(
      () => parseDispatchConfig(table({ roots: ["relative/path"] }), WHERE),
      /must be an absolute path or start with "~\//,
    );
    assert.throws(
      () => parseDispatchConfig(table({ roots: ["/tmp/../escape"] }), WHERE),
      /must not contain a "\.\." segment/,
    );
    assert.throws(
      () => parseDispatchConfig(table({ roots: ["/tmp/bad\npath"] }), WHERE),
      /control character/,
    );
    assert.throws(
      () =>
        parseDispatchConfig(
          table({ roots: ["~/worktrees"] }),
          WHERE,
          new MapEnv({}),
        ),
      /HOME is not set to an absolute path/,
    );
  });

  it("refuses out-of-range or non-integer bounds", () => {
    for (
      const [key, badValue] of [
        ["max_children", 0],
        ["max_children", -1],
        ["max_children", 1.5],
        ["max_children", MAX_DISPATCH_MAX_CHILDREN + 1],
        ["max_children", "3"],
        ["max_wait_seconds", 0],
        ["max_wait_seconds", 2.5],
        ["max_wait_seconds", MAX_DISPATCH_MAX_WAIT_SECONDS + 1],
      ] as const
    ) {
      assert.throws(
        () =>
          parseDispatchConfig(
            table({ roots: ["/tmp/worktrees"], [key]: badValue }),
            WHERE,
          ),
        new RegExp(`dispatch\\.${key}`),
      );
    }
  });
});
