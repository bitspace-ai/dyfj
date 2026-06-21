import { describe, expect, test } from "vitest";
import { resolveSocketPath } from "./uds-path";

function env(map: Record<string, string>) {
  return { get: (k: string) => map[k] };
}

describe("resolveSocketPath", () => {
  test("DYFJ_SOCKET wins over everything", () => {
    expect(
      resolveSocketPath(
        env({ DYFJ_SOCKET: "/explicit.sock", XDG_RUNTIME_DIR: "/run/u", HOME: "/home/c" }),
      ),
    ).toBe("/explicit.sock");
  });

  test("falls back to $XDG_RUNTIME_DIR/dyfj", () => {
    expect(resolveSocketPath(env({ XDG_RUNTIME_DIR: "/run/u", HOME: "/home/c" })))
      .toBe("/run/u/dyfj/workbench.sock");
  });

  test("falls back to ~/.dyfj/run when no XDG_RUNTIME_DIR", () => {
    expect(resolveSocketPath(env({ HOME: "/home/c" })))
      .toBe("/home/c/.dyfj/run/workbench.sock");
  });
});
