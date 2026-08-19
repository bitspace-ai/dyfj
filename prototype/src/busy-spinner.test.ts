import { describe, expect, test } from "vitest";
import { type BusySpinnerOptions, createBusySpinner } from "./busy-spinner";

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
  test("paints the first frame immediately on start", () => {
    const { spinner, writes } = harness();
    spinner.start();
    expect(writes).toEqual([`${ERASE}⠋ working… 0s`]);
  });

  test("advances through the frames on each timer tick", () => {
    const { spinner, writes, ticks } = harness();
    spinner.start();
    ticks[0]();
    ticks[0]();
    expect(writes).toEqual([
      `${ERASE}⠋ working… 0s`,
      `${ERASE}⠙ working… 0s`,
      `${ERASE}⠹ working… 0s`,
    ]);
    // Every repaint starts with erase + carriage return: one line, rewritten.
    for (const write of writes) expect(write.startsWith(ERASE)).toBe(true);
  });

  test("stop erases the line, clears the timer, and is idempotent", () => {
    const { spinner, writes, cleared } = harness();
    spinner.start();
    spinner.stop();
    spinner.stop();
    expect(cleared).toHaveLength(1);
    expect(writes).toEqual([`${ERASE}⠋ working… 0s`, ERASE]);
  });

  test("stop before start disables the spinner permanently", () => {
    const { spinner, writes, ticks } = harness();
    spinner.stop();
    spinner.start();
    expect(writes).toEqual([]);
    expect(ticks).toEqual([]);
  });

  test("start after stop stays a no-op (output has begun; never restart)", () => {
    const { spinner, writes } = harness();
    spinner.start();
    spinner.stop();
    spinner.start();
    expect(writes).toEqual([`${ERASE}⠋ working… 0s`, ERASE]);
  });

  test("double start does not stack timers", () => {
    const { spinner, ticks } = harness();
    spinner.start();
    spinner.start();
    expect(ticks).toHaveLength(1);
  });

  test("disabled spinner never writes or schedules", () => {
    const { spinner, writes, ticks } = harness({ enabled: false });
    spinner.start();
    spinner.stop();
    expect(writes).toEqual([]);
    expect(ticks).toEqual([]);
  });

  test("color mode dims the spinner line only", () => {
    const { spinner, writes } = harness({ color: true });
    spinner.start();
    expect(writes).toEqual([`${ERASE}\x1b[2m⠋ working… 0s\x1b[0m`]);
  });

  test("custom label is rendered", () => {
    const { spinner, writes } = harness({ label: "routing…" });
    spinner.start();
    expect(writes[0]).toContain("routing… 0s");
  });

  test("updateLabel repaints immediately without stacking another timer", () => {
    const { spinner, writes, ticks } = harness();
    spinner.start();
    spinner.updateLabel("thinking…");
    expect(writes).toEqual([
      `${ERASE}⠋ working… 0s`,
      `${ERASE}⠙ thinking… 0s`,
    ]);
    expect(ticks).toHaveLength(1);
    ticks[0]();
    expect(writes[2]).toBe(`${ERASE}⠹ thinking… 0s`);
  });

  test("updateLabel does not restart the elapsed-time counter", () => {
    let now = 0;
    const { spinner, writes, ticks } = harness({ nowMs: () => now });
    spinner.start();
    now = 2_500;
    spinner.updateLabel("thinking…");
    expect(writes.at(-1)).toBe(`${ERASE}⠙ thinking… 2s`);
    now = 5_000;
    ticks[0]();
    expect(writes.at(-1)).toBe(`${ERASE}⠹ thinking… 5s`);
    expect(ticks).toHaveLength(1);
  });

  test("updateLabel is a no-op after stop", () => {
    const { spinner, writes } = harness();
    spinner.start();
    spinner.stop();
    const countBefore = writes.length;
    spinner.updateLabel("thinking…");
    expect(writes.length).toBe(countBefore);
  });
});
