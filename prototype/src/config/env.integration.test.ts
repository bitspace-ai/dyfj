// The real `processEnv` adapter against the `Env` conformance suite. The
// integration lane grants the probe key; the suite restores it after each case.
import { processEnv } from "./env.ts";
import { envConformance } from "../../testing/conformance/env.ts";

const PROBE = "ENV_CONFORMANCE_PROBE";

envConformance({
  name: "processEnv",
  make: () => {
    Deno.env.delete(PROBE);
    return processEnv;
  },
  probeKey: PROBE,
  cleanup: () => Deno.env.delete(PROBE),
});
