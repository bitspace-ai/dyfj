import {
  assertEquals,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
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
    assertEquals(writes, [`${ERASE}⠋ working… 0s`]);
  });

  it("advances through the frames on each timer tick", () => {
    const { spinner, writes, ticks } = harness();
    spinner.start();
    ticks[0]();
    ticks[0]();
    assertEquals(writes, [
      `${ERASE}⠋ working… 0s`,
      `${ERASE}⠙ working… 0s`,
      `${ERASE}⠹ working… 0s`,
    ]);
    // Every repaint starts with erase + carriage return: one line, rewritten.
    for (const write of writes) {
      assertStrictEquals(write.startsWith(ERASE), true);
    }
  });

  it("stop erases the line, clears the timer, and is idempotent", () => {
    const { spinner, writes, cleared } = harness();
    spinner.start();
    spinner.stop();
    spinner.stop();
    assertEquals(cleared.length, 1);
    assertEquals(writes, [`${ERASE}⠋ working… 0s`, ERASE]);
  });

  it("stop before start disables the spinner permanently", () => {
    const { spinner, writes, ticks } = harness();
    spinner.stop();
    spinner.start();
    assertEquals(writes, []);
    assertEquals(ticks, []);
  });

  it("pause erases the line and start resumes without resetting elapsed time", () => {
    let now = 0;
    const { spinner, writes, ticks, cleared } = harness({ nowMs: () => now });
    spinner.start();
    now = 2_500;
    spinner.pause();
    spinner.start();
    assertEquals(cleared, [1]);
    assertEquals(ticks.length, 2);
    assertEquals(writes, [
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
    assertEquals(writes, [`${ERASE}⠋ working… 0s`, ERASE]);
  });

  it("double start does not stack timers", () => {
    const { spinner, ticks } = harness();
    spinner.start();
    spinner.start();
    assertEquals(ticks.length, 1);
  });

  it("disabled spinner never writes or schedules", () => {
    const { spinner, writes, ticks } = harness({ enabled: false });
    spinner.start();
    spinner.stop();
    assertEquals(writes, []);
    assertEquals(ticks, []);
  });

  it("color mode dims the spinner line only", () => {
    const { spinner, writes } = harness({ color: true });
    spinner.start();
    assertEquals(writes, [`${ERASE}\x1b[2m⠋ working… 0s\x1b[0m`]);
  });

  it("custom label is rendered", () => {
    const { spinner, writes } = harness({ label: "routing…" });
    spinner.start();
    assertStringIncludes(writes[0], "routing… 0s");
  });

  it("updateLabel repaints immediately without stacking another timer", () => {
    const { spinner, writes, ticks } = harness();
    spinner.start();
    spinner.updateLabel("thinking…");
    assertEquals(writes, [
      `${ERASE}⠋ working… 0s`,
      `${ERASE}⠙ thinking… 0s`,
    ]);
    assertEquals(ticks.length, 1);
    ticks[0]();
    assertStrictEquals(writes[2], `${ERASE}⠹ thinking… 0s`);
  });

  it("updateLabel does not restart the elapsed-time counter", () => {
    let now = 0;
    const { spinner, writes, ticks } = harness({ nowMs: () => now });
    spinner.start();
    now = 2_500;
    spinner.updateLabel("thinking…");
    assertStrictEquals(writes.at(-1), `${ERASE}⠙ thinking… 2s`);
    now = 5_000;
    ticks[0]();
    assertStrictEquals(writes.at(-1), `${ERASE}⠹ thinking… 5s`);
    assertEquals(ticks.length, 1);
  });

  it("updateLabel is a no-op after stop", () => {
    const { spinner, writes } = harness();
    spinner.start();
    spinner.stop();
    const countBefore = writes.length;
    spinner.updateLabel("thinking…");
    assertStrictEquals(writes.length, countBefore);
  });

  it("updateLabel while paused is applied when animation resumes", () => {
    const { spinner, writes } = harness();
    spinner.start();
    spinner.pause();
    spinner.updateLabel("inspecting…");
    spinner.start();
    assertStrictEquals(writes.at(-1), `${ERASE}⠙ inspecting… 0s`);
  });
});
