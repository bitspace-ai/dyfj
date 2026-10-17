import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isLaneToken,
  LANE_BACKSTOP_ENV,
  LANE_DEADLINE_ENV,
  LANE_PARENT_ENV,
  LANE_TOKEN_ENV,
  laneSupervision,
  laneTokenArgument,
  MAX_TIMER_DELAY_MS,
} from "./lane-supervision.ts";

const TOKEN = "0f8b7c2e-5a41-4d7e-9c3b-2e1f0a9d8c7b";

function reader(values: Record<string, string>) {
  return (name: string) => values[name];
}

test("a run the gate did not start is unsupervised", () => {
  assert.equal(laneSupervision(reader({})), undefined);
  assert.equal(
    laneSupervision(reader({ [LANE_TOKEN_ENV]: TOKEN })),
    undefined,
  );
});

test("a gate lane reads its deadline, backstop, token and expected parent", () => {
  assert.deepEqual(
    laneSupervision(reader({
      [LANE_DEADLINE_ENV]: "120000",
      [LANE_BACKSTOP_ENV]: "180000",
      [LANE_TOKEN_ENV]: TOKEN,
      [LANE_PARENT_ENV]: "4242",
    })),
    { deadlineMs: 120000, backstopMs: 180000, token: TOKEN, parentPid: 4242 },
  );
  assert.deepEqual(
    laneSupervision(reader({
      [LANE_DEADLINE_ENV]: "1",
      [LANE_BACKSTOP_ENV]: String(MAX_TIMER_DELAY_MS),
      [LANE_TOKEN_ENV]: TOKEN,
      [LANE_PARENT_ENV]: "4242",
    }))?.backstopMs,
    MAX_TIMER_DELAY_MS,
  );
});

test("malformed supervision values leave the run unsupervised", () => {
  for (
    const values of [
      { deadline: "0", backstop: "1", token: TOKEN },
      { deadline: "1", backstop: "-5", token: TOKEN },
      { deadline: "1", backstop: "1.5", token: TOKEN },
      // Past the longest delay a timer honours.
      { deadline: "1", backstop: "2147483648", token: TOKEN },
      { deadline: "1", backstop: "1", token: "not-a-token" },
      { deadline: "1", backstop: "1", token: `${TOKEN} extra` },
      // No expected parent, or one no gate can be: the runner would have
      // nothing to compare its parent with.
      { deadline: "1", backstop: "1", token: TOKEN, parent: undefined },
      { deadline: "1", backstop: "1", token: TOKEN, parent: "1" },
      { deadline: "1", backstop: "1", token: TOKEN, parent: "0" },
      { deadline: "1", backstop: "1", token: TOKEN, parent: "-7" },
    ]
  ) {
    assert.equal(
      laneSupervision(reader({
        [LANE_DEADLINE_ENV]: values.deadline,
        [LANE_BACKSTOP_ENV]: values.backstop,
        [LANE_TOKEN_ENV]: values.token,
        ...("parent" in values
          ? values.parent === undefined
            ? {}
            : { [LANE_PARENT_ENV]: values.parent }
          : { [LANE_PARENT_ENV]: "4242" }),
      })),
      undefined,
      JSON.stringify(values),
    );
  }
});

test("a lane token is a lowercase UUID carried as --dyfj-lane", () => {
  assert.deepEqual(laneTokenArgument(TOKEN), `--dyfj-lane=${TOKEN}`);
  assert.equal(isLaneToken(TOKEN), true);
  assert.equal(isLaneToken(TOKEN.toUpperCase()), false);
});
