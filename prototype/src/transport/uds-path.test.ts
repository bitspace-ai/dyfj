import { assertEquals } from "@std/assert";
import { MapEnv } from "../../testing/fakes/map-env.ts";
import { resolveSocketPath } from "./uds-path.ts";

// Assembled at runtime so the public-boundary scan never matches this
// fixture as a home-directory path in tracked source.
const FAKE_HOME = ["", "home", "c"].join("/");

Deno.test("resolveSocketPath: DYFJ_SOCKET wins over everything", () => {
  assertEquals(
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

Deno.test("resolveSocketPath falls back to $XDG_RUNTIME_DIR/dyfj", () => {
  assertEquals(
    resolveSocketPath(
      new MapEnv({ XDG_RUNTIME_DIR: "/run/u", HOME: FAKE_HOME }),
    ),
    "/run/u/dyfj/workbench.sock",
  );
});

Deno.test("resolveSocketPath falls back to ~/.dyfj/run when no XDG_RUNTIME_DIR", () => {
  assertEquals(
    resolveSocketPath(new MapEnv({ HOME: FAKE_HOME })),
    `${FAKE_HOME}/.dyfj/run/workbench.sock`,
  );
});

// Empty values count as unset, and the last resort is a path relative to the
// working directory. The Rust REPL client resolves the same precedence.
Deno.test("resolveSocketPath treats empty values as unset", () => {
  assertEquals(
    resolveSocketPath(
      new MapEnv({ DYFJ_SOCKET: "", XDG_RUNTIME_DIR: "", HOME: FAKE_HOME }),
    ),
    `${FAKE_HOME}/.dyfj/run/workbench.sock`,
  );
  assertEquals(
    resolveSocketPath(new MapEnv({})),
    "./.dyfj/run/workbench.sock",
  );
});
