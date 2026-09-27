// Unit tests for mapping registry tool names to provider wire names.

import {
  assertMatch,
  assertNotStrictEquals,
  assertStrictEquals,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { toolWireNames } from "./tool-names.ts";

describe("tool wire names", () => {
  it("sanitizes dotted command ids and avoids collisions", () => {
    const mapped = toolWireNames([
      { name: "memory.read", description: "a", parameters: {} },
      { name: "memory_read", description: "b", parameters: {} },
    ]);
    assertStrictEquals(mapped[0].wire, "memory_read");
    assertNotStrictEquals(mapped[1].wire, mapped[0].wire);
    assertMatch(mapped[1].wire, /^[a-zA-Z0-9_-]{1,64}$/);
  });
});
