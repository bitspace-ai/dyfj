// Tests for the Node load probe's module selection. Written to `node:`
// builtins only, as the probe is.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isProbedModule } from "./node-load-probe.ts";

describe("isProbedModule", () => {
  it("selects TypeScript modules under the probe roots", () => {
    assert.equal(isProbedModule("prototype/src/engine/mod.ts"), true);
    assert.equal(
      isProbedModule("contracts/workbench/first-product/v1/validate.ts"),
      true,
    );
  });

  it("skips every test file test discovery recognises", () => {
    for (
      const path of [
        "prototype/src/engine/turn.test.ts",
        "prototype/src/engine/turn.spec.ts",
        "prototype/src/store/dolt.integration.test.ts",
        "contracts/workbench/first-product/v1/validate.spec.ts",
      ]
    ) {
      assert.equal(isProbedModule(path), false, path);
    }
  });

  it("skips files outside the probe roots and non-TypeScript files", () => {
    for (
      const path of [
        "scripts/erasable-syntax.ts",
        "prototype/testing/fakes/map-env.ts",
        "prototype/src/README.md",
        "prototype/src/store/generated/rows.json",
      ]
    ) {
      assert.equal(isProbedModule(path), false, path);
    }
  });
});
