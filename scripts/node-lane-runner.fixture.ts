// A stand-in test-lane runner for `node-lane-supervision.test.ts`: supervised
// the way the real runners are (a lane token carrier, the backstop around its
// step, then a stop of its own process group), with one step, the Node subset
// as the real runners start it (`prototype/scripts/node-test-lane.ts`), over
// `<dir>/hang.test.mjs`, a file whose test never ends.
//
// Usage: node node-lane-runner.fixture.ts <dir>
import process from "node:process";
import {
  laneSupervision,
  startBackstop,
  startTokenCarrier,
  stopOwnGroup,
} from "../prototype/scripts/lane-supervision.ts";
import { startNodeTests } from "../prototype/scripts/node-test-lane.ts";

const [dir] = process.argv.slice(2);
if (dir === undefined) {
  console.error("usage: node-lane-runner.fixture.ts <dir>");
  process.exit(64);
}
const supervision = laneSupervision();
startTokenCarrier(supervision);
const run = startNodeTests({
  lane: "stand-in",
  files: ["hang.test.mjs"],
  cwd: dir,
  env: { PATH: process.env.PATH ?? "", DYFJ_FIXTURE_DIR: dir },
  jobs: 1,
});
const backstop = startBackstop(supervision, () => run.kill());
const code = await run.code;
backstop.clear();
await stopOwnGroup(supervision);
process.exit(backstop.expired ? 1 : code);
