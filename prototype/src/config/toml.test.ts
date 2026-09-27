import { assertStrictEquals } from "@std/assert";
import { MapEnv } from "../../testing/fakes/map-env.ts";

const env = (map: Record<string, string> = {}) => new MapEnv(map);
import { configFilePath } from "./toml.ts";

// Assembled at runtime so the public-boundary scan never matches these
// fixtures as home-directory paths in tracked source.
const FAKE_HOME = ["", "home", "x"].join("/");

{ // "configFilePath"
  Deno.test("configFilePath: uses DYFJ_ROOT when set", () => {
    assertStrictEquals(
      configFilePath(env({ DYFJ_ROOT: "/custom" })),
      "/custom/config.toml",
    );
  });

  Deno.test("configFilePath: falls back to ~/.dyfj", () => {
    assertStrictEquals(
      configFilePath(env({ HOME: FAKE_HOME })),
      `${FAKE_HOME}/.dyfj/config.toml`,
    );
  });

  Deno.test("configFilePath: treats an EMPTY DYFJ_ROOT as absent (not '/'), matching the launcher", () => {
    assertStrictEquals(
      configFilePath(env({ DYFJ_ROOT: "", HOME: FAKE_HOME })),
      `${FAKE_HOME}/.dyfj/config.toml`,
    );
  });
}
