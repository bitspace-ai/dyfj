import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_OPENROUTER_UPSTREAM_ORDER,
  parseOpenRouterConfig,
  resolveOpenRouterPolicyForModel,
} from "./openrouter-config.ts";

const where = "/h/.dyfj/config.toml";

const table = (openrouter: unknown) => ({ openrouter });

{ // "parseOpenRouterConfig"
  test("parseOpenRouterConfig: no table leaves every request unconfigured", () => {
    assert.strictEqual(parseOpenRouterConfig(null, where), null);
    assert.strictEqual(parseOpenRouterConfig({}, where), null);
  });

  test("parseOpenRouterConfig: reads defaults, including a full endpoint slug", () => {
    const config = parseOpenRouterConfig(
      table({
        upstream_order: ["Fireworks", "fireworks/fp8"],
        allow_fallbacks: false,
        zdr: true,
      }),
      where,
    );
    assert.deepStrictEqual(config?.defaults, {
      upstreamOrder: ["Fireworks", "fireworks/fp8"],
      allowFallbacks: false,
      zdr: true,
    });
  });

  test("parseOpenRouterConfig: a defaults table with no keys is no policy", () => {
    const config = parseOpenRouterConfig(table({}), where);
    assert.deepStrictEqual(config?.defaults, {});
    assert.strictEqual(resolveOpenRouterPolicyForModel(config!, "any/slug"), undefined);
  });

  test("parseOpenRouterConfig: per-model overrides merge over the defaults field by field", () => {
    const config = parseOpenRouterConfig(
      table({
        upstream_order: ["Fireworks"],
        zdr: true,
        models: {
          "deepseek/deepseek-v4.1-flash-1017": {
            upstream_order: ["fireworks/fp8"],
            allow_fallbacks: false,
          },
        },
      }),
      where,
    );
    assert.deepStrictEqual(
      resolveOpenRouterPolicyForModel(config!, "deepseek/deepseek-v4.1-flash-1017"),
      {
        upstreamOrder: ["fireworks/fp8"],
        allowFallbacks: false,
        // inherited from the defaults, which the override did not name
        zdr: true,
      },
    );
    // A model with no override gets the defaults whole.
    assert.deepStrictEqual(resolveOpenRouterPolicyForModel(config!, "other/slug"), {
      upstreamOrder: ["Fireworks"],
      zdr: true,
    });
  });

  test("parseOpenRouterConfig: a model override alone stands without defaults", () => {
    const config = parseOpenRouterConfig(
      table({ models: { "only/one": { zdr: true } } }),
      where,
    );
    assert.deepStrictEqual(resolveOpenRouterPolicyForModel(config!, "only/one"), {
      zdr: true,
    });
    assert.strictEqual(resolveOpenRouterPolicyForModel(config!, "other/slug"), undefined);
    assert.strictEqual(resolveOpenRouterPolicyForModel(undefined, "only/one"), undefined);
  });

  test("parseOpenRouterConfig: refuses an empty upstream_order", () => {
    assert.throws(
      () => parseOpenRouterConfig(table({ upstream_order: [] }), where),
      /openrouter\.upstream_order must not be empty/,
    );
  });

  test("parseOpenRouterConfig: refuses an entry with a leading, trailing or doubled slash", () => {
    for (const entry of ["/fireworks", "fireworks/", "fireworks//fp8"]) {
      assert.throws(
        () => parseOpenRouterConfig(table({ upstream_order: [entry] }), where),
        /empty path segment/,
        entry,
      );
    }
  });

  test("parseOpenRouterConfig: refuses an entry with leading or trailing whitespace", () => {
    for (const entry of ["   ", " Fireworks ", "fireworks/ "]) {
      assert.throws(
        () => parseOpenRouterConfig(table({ upstream_order: [entry] }), where),
        /leading or trailing whitespace/,
        JSON.stringify(entry),
      );
    }
  });

  test("parseOpenRouterConfig: refuses a slash-separated segment that is whitespace alone", () => {
    for (const entry of [" / ", "fireworks/  ", "fireworks/ /fp8"]) {
      assert.throws(
        () => parseOpenRouterConfig(table({ upstream_order: [entry] }), where),
        /leading or trailing whitespace|empty path segment/,
        JSON.stringify(entry),
      );
    }
  });

  test("parseOpenRouterConfig: refuses an entry outside the allowed characters", () => {
    for (const entry of ["", "fire works\n", "fire%20works", "a".repeat(65)]) {
      assert.throws(
        () => parseOpenRouterConfig(table({ upstream_order: [entry] }), where),
        /is not a provider name or endpoint slug|non-empty string/,
        JSON.stringify(entry),
      );
    }
  });

  test("parseOpenRouterConfig: refuses more upstream entries than the limit", () => {
    const tooMany = Array.from(
      { length: MAX_OPENROUTER_UPSTREAM_ORDER + 1 },
      (_, index) => `upstream-${index}`,
    );
    assert.throws(
      () => parseOpenRouterConfig(table({ upstream_order: tooMany }), where),
      /the limit is 16/,
    );
  });

  test("parseOpenRouterConfig: refuses allow_fallbacks = false without an order", () => {
    assert.throws(
      () => parseOpenRouterConfig(table({ allow_fallbacks: false }), where),
      /allow_fallbacks = false needs openrouter\.upstream_order/,
    );
    assert.throws(
      () =>
        parseOpenRouterConfig(
          table({ models: { "a/b": { allow_fallbacks: false } } }),
          where,
        ),
      /openrouter\.models\."a\/b"\.allow_fallbacks = false needs/,
    );
  });

  test("parseOpenRouterConfig: a per-model allow_fallbacks = false takes the defaults' order", () => {
    const config = parseOpenRouterConfig(
      table({
        upstream_order: ["Fireworks"],
        models: { "a/b": { allow_fallbacks: false } },
      }),
      where,
    );
    assert.deepStrictEqual(resolveOpenRouterPolicyForModel(config!, "a/b"), {
      upstreamOrder: ["Fireworks"],
      allowFallbacks: false,
    });
  });

  test("parseOpenRouterConfig: allow_fallbacks = true needs no order", () => {
    const config = parseOpenRouterConfig(table({ allow_fallbacks: true }), where);
    assert.deepStrictEqual(config?.defaults, { allowFallbacks: true });
  });

  test("parseOpenRouterConfig: refuses unknown keys at both levels", () => {
    assert.throws(
      () => parseOpenRouterConfig(table({ zero_data_retention: true }), where),
      /unknown key openrouter\.zero_data_retention/,
    );
    assert.throws(
      () => parseOpenRouterConfig(table({ models: { "a/b": { order: ["x"] } } }), where),
      /unknown key openrouter\.models\."a\/b"\.order/,
    );
  });

  test("parseOpenRouterConfig: refuses a non-table section or override", () => {
    assert.throws(
      () => parseOpenRouterConfig({ openrouter: ["Fireworks"] }, where),
      /\[openrouter\] must be a table/,
    );
    assert.throws(
      () => parseOpenRouterConfig(table({ models: { "a/b": [] } }), where),
      /must be a table/,
    );
  });

  test("parseOpenRouterConfig: refuses a non-boolean field", () => {
    assert.throws(
      () => parseOpenRouterConfig(table({ zdr: "true" }), where),
      /openrouter\.zdr must be a boolean/,
    );
  });
}
