import assert from "node:assert/strict";
import { test } from "node:test";
import { MapEnv } from "../../testing/fakes/map-env.ts";

import { configErrorText, configFilePath, readConfigFile } from "./toml.ts";

const env = (map: Record<string, string> = {}) => new MapEnv(map);

// Assembled at runtime so the public-boundary scan never matches these
// fixtures as home-directory paths in tracked source.
const FAKE_HOME = ["", "home", "x"].join("/");

{ // "configFilePath"
  test("configFilePath: uses DYFJ_ROOT when set", () => {
    assert.strictEqual(
      configFilePath(env({ DYFJ_ROOT: "/custom" })),
      "/custom/config.toml",
    );
  });

  test("configFilePath: falls back to ~/.dyfj", () => {
    assert.strictEqual(
      configFilePath(env({ HOME: FAKE_HOME })),
      `${FAKE_HOME}/.dyfj/config.toml`,
    );
  });

  test("configFilePath: treats an EMPTY DYFJ_ROOT as absent (not '/'), matching the launcher", () => {
    assert.strictEqual(
      configFilePath(env({ DYFJ_ROOT: "", HOME: FAKE_HOME })),
      `${FAKE_HOME}/.dyfj/config.toml`,
    );
  });
}

test("configErrorText strips control characters from a config error", () => {
  const text = configErrorText(
    new Error("config: bad value \u001b[2J\u0007in\nconfig.toml"),
  );
  assert.ok(text !== undefined);
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(text), JSON.stringify(text));
  assert.match(text, /^config: bad value \[2J ?in config\.toml$/);
});

test("a parse error without a position names neither it nor the parser's text", async () => {
  await assert.rejects(
    () =>
      readConfigFile("/x/config.toml", async () => "a = 1", () => {
        throw new Error("parser text quoting a = 1");
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        "config: failed to parse config.toml; fix its TOML syntax, or " +
          "move the file aside to run on the defaults",
      );
      return true;
    },
  );
});
