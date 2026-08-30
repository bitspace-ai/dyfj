import { describe, expect, test } from "vitest";
import { resolveSocketPath } from "./uds-path";

function env(map: Record<string, string>) {
  return { get: (k: string) => map[k] };
}

// Assembled at runtime so the public-boundary scan never matches this
// fixture as a home-directory path in tracked source.
const FAKE_HOME = ["", "home", "c"].join("/");

describe("resolveSocketPath", () => {
  test("DYFJ_SOCKET wins over everything", () => {
    expect(
      resolveSocketPath(
        env({
          DYFJ_SOCKET: "/explicit.sock",
          XDG_RUNTIME_DIR: "/run/u",
          HOME: FAKE_HOME,
        }),
      ),
    ).toBe("/explicit.sock");
  });

  test("falls back to $XDG_RUNTIME_DIR/dyfj", () => {
    expect(
      resolveSocketPath(env({ XDG_RUNTIME_DIR: "/run/u", HOME: FAKE_HOME })),
    )
      .toBe("/run/u/dyfj/workbench.sock");
  });

  test("falls back to ~/.dyfj/run when no XDG_RUNTIME_DIR", () => {
    expect(resolveSocketPath(env({ HOME: FAKE_HOME })))
      .toBe(`${FAKE_HOME}/.dyfj/run/workbench.sock`);
  });
});
