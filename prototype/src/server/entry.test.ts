import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { MapEnv } from "../../testing/fakes/map-env.ts";
import { loadConfig } from "../config/mod.ts";
import {
  CONFIG_ERROR_EXIT_CODE,
  configErrorLine,
  runRuntimeEntry,
} from "./entry.ts";

function ports() {
  const said: string[] = [];
  const setExitCode = mock.fn((_code: number) => {});
  return {
    said,
    setExitCode,
    ports: { say: (l: string) => said.push(l), setExitCode },
  };
}

describe("runtime entry guard", () => {
  it("reports a config error as one line and sets a non-zero exit status", async () => {
    const p = ports();
    await runRuntimeEntry(
      () =>
        Promise.reject(
          new Error(
            "config: the default max tool steps (8) is above the tool-step ceiling (4)",
          ),
        ),
      p.ports,
    );
    assert.deepEqual(p.said, [
      "dyfj runtime: config: the default max tool steps (8) is above the tool-step ceiling (4)",
    ]);
    assert.equal(p.setExitCode.mock.callCount(), 1);
    assert.equal(p.setExitCode.mock.calls[0].arguments[0], CONFIG_ERROR_EXIT_CODE);
    assert.notEqual(CONFIG_ERROR_EXIT_CODE, 0);
  });

  it("reports the real tool-step ceiling error from loadConfig", async () => {
    const p = ports();
    const env = new MapEnv({
      HOME: "/h",
      DYFJ_MAX_TOOL_STEPS: "8",
      DYFJ_MAX_TOOL_STEPS_CEILING: "4",
    });
    const notFound = () =>
      Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    await runRuntimeEntry(async () => {
      await loadConfig({ env, readTextFile: notFound });
    }, p.ports);
    assert.equal(p.said.length, 1);
    assert.match(p.said[0], /above the tool-step ceiling \(4\)/);
    assert.doesNotMatch(p.said[0], /\n|\bat .*\.ts/);
    assert.equal(p.setExitCode.mock.callCount(), 1);
  });

  it("keeps the report to a single line", () => {
    assert.equal(
      configErrorLine(new Error("config: bad\n  at somewhere\nmore")),
      "dyfj runtime: config: bad at somewhere more",
    );
  });

  it("rethrows an error that is not a config error, with its stack", async () => {
    const p = ports();
    const failure = new Error("socket exploded");
    await assert.rejects(
      runRuntimeEntry(() => Promise.reject(failure), p.ports),
      (error) => error === failure,
    );
    assert.deepEqual(p.said, []);
    assert.equal(p.setExitCode.mock.callCount(), 0);
  });

  it("does nothing when the boot succeeds", async () => {
    const p = ports();
    await runRuntimeEntry(() => Promise.resolve(), p.ports);
    assert.deepEqual(p.said, []);
    assert.equal(p.setExitCode.mock.callCount(), 0);
  });
});
