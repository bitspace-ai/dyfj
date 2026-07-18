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
    expect(writes).toEqual([`${ERASE}⠋ working…`]);
  });

  test("advances through the frames on each timer tick", () => {
    const { spinner, writes, ticks } = harness();
    spinner.start();
    ticks[0]();
    ticks[0]();
    expect(writes).toEqual([
      `${ERASE}⠋ working…`,
      `${ERASE}⠙ working…`,
      `${ERASE}⠹ working…`,
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
    expect(writes).toEqual([`${ERASE}⠋ working…`, ERASE]);
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
    expect(writes).toEqual([`${ERASE}⠋ working…`, ERASE]);
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
    expect(writes).toEqual([`${ERASE}\x1b[2m⠋ working…\x1b[0m`]);
  });

  test("custom label is rendered", () => {
    const { spinner, writes } = harness({ label: "routing…" });
    spinner.start();
    expect(writes[0]).toContain("routing…");
  });
});
