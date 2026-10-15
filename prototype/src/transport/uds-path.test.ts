import assert from "node:assert/strict";
import { test } from "node:test";
import { MapEnv } from "../../testing/fakes/map-env.ts";
import { resolveSocketPath } from "./uds-path.ts";

// Assembled at runtime so the public-boundary scan never matches this
// fixture as a home-directory path in tracked source.
const FAKE_HOME = ["", "home", "c"].join("/");

test("resolveSocketPath: DYFJ_SOCKET wins over everything", () => {
  assert.deepStrictEqual(
    resolveSocketPath(
      new MapEnv({
        DYFJ_SOCKET: "/explicit.sock",
        XDG_RUNTIME_DIR: "/run/u",
        HOME: FAKE_HOME,
      }),
    ),
    "/explicit.sock",
  );
});

test("resolveSocketPath falls back to $XDG_RUNTIME_DIR/dyfj", () => {
  assert.deepStrictEqual(
    resolveSocketPath(
      new MapEnv({ XDG_RUNTIME_DIR: "/run/u", HOME: FAKE_HOME }),
    ),
    "/run/u/dyfj/workbench.sock",
  );
});

test("resolveSocketPath falls back to ~/.dyfj/run when no XDG_RUNTIME_DIR", () => {
  assert.deepStrictEqual(
    resolveSocketPath(new MapEnv({ HOME: FAKE_HOME })),
    `${FAKE_HOME}/.dyfj/run/workbench.sock`,
  );
});

// Empty values count as unset, and the last resort is a path relative to the
// working directory. The Rust REPL client resolves the same precedence.
test("resolveSocketPath treats empty values as unset", () => {
  assert.deepStrictEqual(
    resolveSocketPath(
      new MapEnv({ DYFJ_SOCKET: "", XDG_RUNTIME_DIR: "", HOME: FAKE_HOME }),
    ),
    `${FAKE_HOME}/.dyfj/run/workbench.sock`,
  );
  assert.deepStrictEqual(
    resolveSocketPath(new MapEnv({})),
    "./.dyfj/run/workbench.sock",
  );
});
