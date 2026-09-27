import { ManualClock } from "../../testing/fakes/manual-clock.ts";
import { clockConformance } from "../../testing/conformance/clock.ts";
import { systemClock } from "./clock.ts";

clockConformance({ name: "systemClock", make: () => systemClock });

clockConformance({
  name: "ManualClock",
  make: () => new ManualClock({ start: Date.UTC(2026, 0, 5, 13) }),
});
