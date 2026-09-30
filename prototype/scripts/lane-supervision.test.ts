import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  isLaneToken,
  LANE_BACKSTOP_ENV,
  LANE_DEADLINE_ENV,
  LANE_TOKEN_ENV,
  laneScriptArgs,
  laneSupervision,
  laneTokenArgument,
} from "./lane-supervision.ts";

const TOKEN = "0f8b7c2e-5a41-4d7e-9c3b-2e1f0a9d8c7b";

function reader(values: Record<string, string>) {
  return (name: string) => values[name];
}

Deno.test("a run the gate did not start is unsupervised", () => {
  assertStrictEquals(laneSupervision(reader({})), undefined);
  assertStrictEquals(
    laneSupervision(reader({ [LANE_TOKEN_ENV]: TOKEN })),
    undefined,
  );
});

Deno.test("a gate lane reads its deadline, backstop and token", () => {
  assertEquals(
    laneSupervision(reader({
      [LANE_DEADLINE_ENV]: "120000",
      [LANE_BACKSTOP_ENV]: "180000",
      [LANE_TOKEN_ENV]: TOKEN,
    })),
    { deadlineMs: 120000, backstopMs: 180000, token: TOKEN },
  );
});

Deno.test("malformed supervision values leave the run unsupervised", () => {
  for (
    const values of [
      { deadline: "0", backstop: "1", token: TOKEN },
      { deadline: "1", backstop: "-5", token: TOKEN },
      { deadline: "1", backstop: "1.5", token: TOKEN },
      { deadline: "1", backstop: "1", token: "not-a-token" },
      { deadline: "1", backstop: "1", token: `${TOKEN} extra` },
    ]
  ) {
    assertStrictEquals(
      laneSupervision(reader({
        [LANE_DEADLINE_ENV]: values.deadline,
        [LANE_BACKSTOP_ENV]: values.backstop,
        [LANE_TOKEN_ENV]: values.token,
      })),
      undefined,
      JSON.stringify(values),
    );
  }
});

Deno.test("the lane token rides after the caller's own script arguments", () => {
  const supervision = { deadlineMs: 1, backstopMs: 2, token: TOKEN };
  assertEquals(laneScriptArgs(undefined), []);
  assertEquals(laneScriptArgs(undefined, ["--update"]), ["--", "--update"]);
  assertEquals(laneScriptArgs(supervision), [
    "--",
    laneTokenArgument(TOKEN),
  ]);
  assertEquals(laneScriptArgs(supervision, ["--update"]), [
    "--",
    "--update",
    `--dyfj-lane=${TOKEN}`,
  ]);
  assertStrictEquals(isLaneToken(TOKEN), true);
  assertStrictEquals(isLaneToken(TOKEN.toUpperCase()), false);
});
