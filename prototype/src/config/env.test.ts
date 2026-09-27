import { MapEnv } from "../../testing/fakes/map-env.ts";
import { envConformance } from "../../testing/conformance/env.ts";

envConformance({
  name: "MapEnv",
  make: () => new MapEnv(),
  probeKey: "ENV_CONFORMANCE_PROBE",
});
