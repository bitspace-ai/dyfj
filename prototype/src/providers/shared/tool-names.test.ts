// Unit tests for mapping registry tool names to provider wire names.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toolWireNames } from "./tool-names.ts";

describe("tool wire names", () => {
  it("sanitizes dotted command ids and avoids collisions", () => {
    const mapped = toolWireNames([
      { name: "memory.read", description: "a", parameters: {} },
      { name: "memory_read", description: "b", parameters: {} },
    ]);
    assert.strictEqual(mapped[0].wire, "memory_read");
    assert.notStrictEqual(mapped[1].wire, mapped[0].wire);
    assert.match(mapped[1].wire, /^[a-zA-Z0-9_-]{1,64}$/);
  });
});
