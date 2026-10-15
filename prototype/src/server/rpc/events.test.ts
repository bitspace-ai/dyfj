import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkbenchSessionEvent } from "../../contract/mod.ts";
import { RpcErrorCode } from "../../transport/mod.ts";
import { callRpc, rpcFailure } from "../../../testing/builders/rpc.ts";
import { buildEventsHandlers, type SessionEventsRequest } from "./events.ts";

function handlers(requests: SessionEventsRequest[] = []) {
  return buildEventsHandlers({
    fetchSessionEvents: (input) => {
      requests.push(input);
      return Promise.resolve(
        [{
          id: "e1",
          sessionId: input.sessionId,
        }] as unknown as WorkbenchSessionEvent[],
      );
    },
  });
}

test("events/query returns events for a session", async () => {
  const requests: SessionEventsRequest[] = [];
  assert.deepStrictEqual(
    await callRpc(handlers(requests), "events/query", { sessionId: "s1" }),
    { events: [{ id: "e1", sessionId: "s1" }] },
  );
  assert.deepStrictEqual(requests, [{
    sessionId: "s1",
    asOf: undefined,
    limit: 500,
  }]);
});

test("events/query without a sessionId -> invalidParams", async () => {
  const error = await rpcFailure(handlers(), "events/query", {});
  assert.deepStrictEqual(error.code, RpcErrorCode.invalidParams);
});

test("events/query with a malformed asOf -> invalidParams", async () => {
  const error = await rpcFailure(handlers(), "events/query", {
    sessionId: "s1",
    asOf: "not-a-timestamp",
  });
  assert.deepStrictEqual(error.code, RpcErrorCode.invalidParams);
});

test("events/query rejects asOf longer than 64 characters", async () => {
  const error = await rpcFailure(handlers(), "events/query", {
    sessionId: "01TEST_EVENTS_SESSION",
    asOf: "2026-08-15T12:00:00.000Z" + "0".repeat(100),
  });
  assert.deepStrictEqual(error.code, RpcErrorCode.invalidParams);
});

test("events/query with an invalid limit -> invalidParams", async () => {
  for (const limit of [0, -5, "100", 1001]) {
    const error = await rpcFailure(handlers(), "events/query", {
      sessionId: "s1",
      limit,
    });
    assert.deepStrictEqual(
      error.code,
      RpcErrorCode.invalidParams,
      `limit ${limit}`,
    );
  }
});
