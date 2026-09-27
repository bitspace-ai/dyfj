import { storeConformance } from "../../testing/conformance/store.ts";
import { MemoryStore } from "./mod.ts";

storeConformance({
  name: "MemoryStore",
  make: (seed, options) => Promise.resolve(new MemoryStore(seed, options)),
  dispose: (store) => store.close(),
  tick: () => new Promise((resolve) => setTimeout(resolve, 3)),
});
