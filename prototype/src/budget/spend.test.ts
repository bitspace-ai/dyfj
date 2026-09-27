/**
 * Unit tests for budget/spend.ts: spend baselines through the store's spend
 * reader, and the local-day boundary driven by the `Clock` port.
 */

import { assertEquals, assertStrictEquals } from "@std/assert";
import { ManualClock } from "../../testing/fakes/manual-clock.ts";
import { fetchSpendBaselines, localDayKey, localDayStart } from "./spend.ts";

const SESSION_ID = "01TEST0SESSION0000000000000";

Deno.test("daily envelope: fetchSpendBaselines reads the store's spend rollup for the session and day", async () => {
  // Mid-afternoon local time on 2026-07-06: the day start is local midnight.
  const clock = new ManualClock({ start: new Date(2026, 6, 6, 15).getTime() });
  const calls: Array<[string, string]> = [];
  const baselines = await fetchSpendBaselines(
    {
      baselines: (sessionId, dayStart) => {
        calls.push([sessionId, dayStart]);
        return Promise.resolve({
          sessionSpentUsd: 0.12,
          sessionSpentTodayUsd: 0.05,
          dailyOtherSessionsUsd: 3.4,
        });
      },
    },
    SESSION_ID,
    clock,
  );
  assertEquals(baselines, {
    sessionSpentUsd: 0.12,
    sessionSpentTodayUsd: 0.05,
    dailyOtherSessionsUsd: 3.4,
  });
  assertEquals(calls, [[SESSION_ID, "2026-07-06 00:00:00"]]);
});

Deno.test("daily envelope: localDayStart is a local-midnight timestamp string", () => {
  const start = localDayStart(new Date(2026, 6, 6, 15, 30));
  assertStrictEquals(start, "2026-07-06 00:00:00");
  assertStrictEquals(localDayKey(new Date(2026, 6, 6, 15, 30)), "2026-07-06");
});
