import { assertStrictEquals, assertThrows } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  DENO_EXECUTABLE_DIAGNOSTIC,
  resolveDenoExecutable,
  selectedDenoExecutable,
  validateDenoExecutable,
} from "./deno-executable.ts";

describe("Deno executable authority", () => {
  it("accepts an absolute selected executable", () => {
    assertStrictEquals(
      validateDenoExecutable("/fixtures/runtime/deno"),
      "/fixtures/runtime/deno",
    );
  });

  for (
    const selected of [
      "deno",
      "./deno",
      "/fixtures/deno,other",
      "/fixtures/deno\nother",
    ]
  ) {
    it(
      `rejects an unavailable or unsafe selection without echoing it: ${
        JSON.stringify(selected)
      }`,
      () => {
        assertThrows(
          () => validateDenoExecutable(selected),
          Error,
          DENO_EXECUTABLE_DIAGNOSTIC,
        );
      },
    );
  }

  it("reuses only an inherited selection matching the running executable", () => {
    assertStrictEquals(
      resolveDenoExecutable(
        "/fixtures/runtime/deno",
        "/fixtures/runtime/deno",
      ),
      "/fixtures/runtime/deno",
    );
    assertThrows(
      () =>
        resolveDenoExecutable(
          "/fixtures/runtime/deno",
          "/fixtures/other/deno",
        ),
      Error,
      DENO_EXECUTABLE_DIAGNOSTIC,
    );
  });

  it("reads and validates the selected executable exactly once", () => {
    let reads = 0;
    assertStrictEquals(
      selectedDenoExecutable(() => {
        reads += 1;
        return "/fixtures/runtime/deno";
      }),
      "/fixtures/runtime/deno",
    );
    assertStrictEquals(reads, 1);
    assertThrows(
      () => selectedDenoExecutable(() => "deno"),
      Error,
      DENO_EXECUTABLE_DIAGNOSTIC,
    );
  });
});
