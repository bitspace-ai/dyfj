import { describe, expect, test } from "vitest";
import {
  DENO_EXECUTABLE_DIAGNOSTIC,
  resolveDenoExecutable,
  selectedDenoExecutable,
  validateDenoExecutable,
} from "./deno-executable.ts";

describe("Deno executable authority", () => {
  test("accepts an absolute selected executable", () => {
    expect(validateDenoExecutable("/fixtures/runtime/deno")).toBe(
      "/fixtures/runtime/deno",
    );
  });

  test.each([
    "deno",
    "./deno",
    "/fixtures/deno,other",
    "/fixtures/deno\nother",
  ])(
    "rejects an unavailable or unsafe selection without echoing it: %j",
    (selected) => {
      expect(() => validateDenoExecutable(selected)).toThrow(
        DENO_EXECUTABLE_DIAGNOSTIC,
      );
    },
  );

  test("reuses only an inherited selection matching the running executable", () => {
    expect(
      resolveDenoExecutable(
        "/fixtures/runtime/deno",
        "/fixtures/runtime/deno",
      ),
    ).toBe("/fixtures/runtime/deno");
    expect(() =>
      resolveDenoExecutable(
        "/fixtures/runtime/deno",
        "/fixtures/other/deno",
      )
    ).toThrow(DENO_EXECUTABLE_DIAGNOSTIC);
  });

  test("reads and validates the selected executable exactly once", () => {
    let reads = 0;
    expect(
      selectedDenoExecutable(() => {
        reads += 1;
        return "/fixtures/runtime/deno";
      }),
    ).toBe("/fixtures/runtime/deno");
    expect(reads).toBe(1);
    expect(() => selectedDenoExecutable(() => "deno")).toThrow(
      DENO_EXECUTABLE_DIAGNOSTIC,
    );
  });
});
