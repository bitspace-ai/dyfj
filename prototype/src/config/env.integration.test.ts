// The real `processEnv` adapter against the `Env` conformance suite. The
// integration lane grants the probe key; each case starts with it unset and
// the suite restores whatever value the process had before.
import { processEnv } from "./env.ts";
import { envConformance } from "../../testing/conformance/env.ts";

const PROBE = "ENV_CONFORMANCE_PROBE";
const original = Deno.env.get(PROBE);

envConformance({
  name: "processEnv",
  make: () => {
    Deno.env.delete(PROBE);
    return processEnv;
  },
  probeKey: PROBE,
  cleanup: () => {
    if (original === undefined) Deno.env.delete(PROBE);
    else Deno.env.set(PROBE, original);
  },
});
