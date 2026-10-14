import assert from "node:assert/strict";
import { describe, it } from "@std/testing/bdd";
import { type BusySpinnerOptions, createBusySpinner } from "./busy-spinner.ts";

const ERASE = "\r\x1b[2K";

function harness(overrides: Partial<BusySpinnerOptions> = {}) {
  const writes: string[] = [];
  const ticks: Array<() => void> = [];
  const cleared: unknown[] = [];
  const spinner = createBusySpinner({
    write: (text) => writes.push(text),
    enabled: true,
    color: false,
    setIntervalFn: (callback) => {
      ticks.push(callback);
      return ticks.length;
    },
    clearIntervalFn: (id) => cleared.push(id),
    ...overrides,
  });
  return { spinner, writes, ticks, cleared };
}

describe("createBusySpinner", () => {
  it("paints the first frame immediately on start", () => {
    const { spinner, writes } = harness();
    spinner.start();
    assert.deepStrictEqual(writes, [`${ERASE}⠋ working… 0s`]);
  });

  it("advances through the frames on each timer tick", () => {
    const { spinner, writes, ticks } = harness();
    spinner.start();
    ticks[0]();
    ticks[0]();
    assert.deepStrictEqual(writes, [
      `${ERASE}⠋ working… 0s`,
      `${ERASE}⠙ working… 0s`,
      `${ERASE}⠹ working… 0s`,
    ]);
    // Every repaint starts with erase + carriage return: one line, rewritten.
    for (const write of writes) {
      assert.strictEqual(write.startsWith(ERASE), true);
    }
  });

  it("stop erases the line, clears the timer, and is idempotent", () => {
    const { spinner, writes, cleared } = harness();
    spinner.start();
    spinner.stop();
    spinner.stop();
    assert.deepStrictEqual(cleared.length, 1);
    assert.deepStrictEqual(writes, [`${ERASE}⠋ working… 0s`, ERASE]);
  });

  it("stop before start disables the spinner permanently", () => {
    const { spinner, writes, ticks } = harness();
    spinner.stop();
    spinner.start();
    assert.deepStrictEqual(writes, []);
    assert.deepStrictEqual(ticks, []);
  });

  it("pause erases the line and start resumes without resetting elapsed time", () => {
    let now = 0;
    const { spinner, writes, ticks, cleared } = harness({ nowMs: () => now });
    spinner.start();
    now = 2_500;
    spinner.pause();
    spinner.start();
    assert.deepStrictEqual(cleared, [1]);
    assert.deepStrictEqual(ticks.length, 2);
    assert.deepStrictEqual(writes, [
      `${ERASE}⠋ working… 0s`,
      ERASE,
      `${ERASE}⠙ working… 2s`,
    ]);
  });

  it("start after terminal stop stays a no-op", () => {
    const { spinner, writes } = harness();
    spinner.start();
    spinner.stop();
    spinner.start();
    assert.deepStrictEqual(writes, [`${ERASE}⠋ working… 0s`, ERASE]);
  });

  it("double start does not stack timers", () => {
    const { spinner, ticks } = harness();
    spinner.start();
    spinner.start();
    assert.deepStrictEqual(ticks.length, 1);
  });

  it("disabled spinner never writes or schedules", () => {
    const { spinner, writes, ticks } = harness({ enabled: false });
    spinner.start();
    spinner.stop();
    assert.deepStrictEqual(writes, []);
    assert.deepStrictEqual(ticks, []);
  });

  it("color mode dims the spinner line only", () => {
    const { spinner, writes } = harness({ color: true });
    spinner.start();
    assert.deepStrictEqual(writes, [`${ERASE}\x1b[2m⠋ working… 0s\x1b[0m`]);
  });

  it("custom label is rendered", () => {
    const { spinner, writes } = harness({ label: "routing…" });
    spinner.start();
    assert.ok(writes[0].includes("routing… 0s"), `expected writes[0] to include "routing… 0s"`);
  });

  it("updateLabel repaints immediately without stacking another timer", () => {
    const { spinner, writes, ticks } = harness();
    spinner.start();
    spinner.updateLabel("thinking…");
    assert.deepStrictEqual(writes, [
      `${ERASE}⠋ working… 0s`,
      `${ERASE}⠙ thinking… 0s`,
    ]);
    assert.deepStrictEqual(ticks.length, 1);
    ticks[0]();
    assert.strictEqual(writes[2], `${ERASE}⠹ thinking… 0s`);
  });

  it("updateLabel does not restart the elapsed-time counter", () => {
    let now = 0;
    const { spinner, writes, ticks } = harness({ nowMs: () => now });
    spinner.start();
    now = 2_500;
    spinner.updateLabel("thinking…");
    assert.strictEqual(writes.at(-1), `${ERASE}⠙ thinking… 2s`);
    now = 5_000;
    ticks[0]();
    assert.strictEqual(writes.at(-1), `${ERASE}⠹ thinking… 5s`);
    assert.deepStrictEqual(ticks.length, 1);
  });

  it("updateLabel is a no-op after stop", () => {
    const { spinner, writes } = harness();
    spinner.start();
    spinner.stop();
    const countBefore = writes.length;
    spinner.updateLabel("thinking…");
    assert.strictEqual(writes.length, countBefore);
  });

  it("updateLabel while paused is applied when animation resumes", () => {
    const { spinner, writes } = harness();
    spinner.start();
    spinner.pause();
    spinner.updateLabel("inspecting…");
    spinner.start();
    assert.strictEqual(writes.at(-1), `${ERASE}⠙ inspecting… 0s`);
  });
});
