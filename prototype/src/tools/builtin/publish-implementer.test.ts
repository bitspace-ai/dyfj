import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EventReader } from "../../store/mod.ts";
import {
  EVENT_PAGE_SIZE,
  resolveImplementer,
} from "./publish-implementer.ts";

/** An event reader over fixed rows, recording the queries it received. */
function events(rows: Record<string, string>[]): EventReader & {
  queries: { limit: number; order: string; sessionId: string }[];
} {
  const queries: { limit: number; order: string; sessionId: string }[] = [];
  return {
    queries,
    bySession: (query: { limit: number; order: string; sessionId: string }) => {
      queries.push(query);
      return Promise.resolve(rows as never);
    },
    exists: () => Promise.resolve(false),
    countBySession: () => Promise.resolve(rows.length),
    latestRun: () => Promise.resolve(null),
  } as unknown as EventReader & {
    queries: { limit: number; order: string; sessionId: string }[];
  };
}

/** A reader that answers with `size` rows of the same completed model call. */
function sized(sizes: readonly number[]): EventReader & { limits: number[] } {
  const limits: number[] = [];
  let call = 0;
  return {
    limits,
    bySession: (query: { limit: number }) => {
      limits.push(query.limit);
      const size = sizes[call++] ?? 0;
      return Promise.resolve(
        Array.from({ length: size }, () => ({
          event_type: "model_response",
          stop_reason: "stop",
          model_id: "claude-opus-5",
        })) as never,
      );
    },
    exists: () => Promise.resolve(false),
    countBySession: () => Promise.resolve(0),
    latestRun: () => Promise.resolve(null),
  } as unknown as EventReader & { limits: number[] };
}

describe("publish implementer", () => {
  it("names the model slug that ran the session's turn", async () => {
    const implementer = await resolveImplementer({
      sessionId: "s1",
      events: events([
        {
          event_type: "model_response",
          stop_reason: "stop",
          model_id: "claude-opus-5",
        },
      ]),
    });
    assert.strictEqual(implementer, "claude-opus-5");
  });

  it("joins several slugs, sorted and distinct", async () => {
    const implementer = await resolveImplementer({
      sessionId: "s1",
      events: events([
        { event_type: "model_response", stop_reason: "stop", model_id: "gpt-6" },
        {
          event_type: "model_response",
          stop_reason: "tool_use",
          model_id: "claude-opus-5",
        },
        { event_type: "model_response", stop_reason: "stop", model_id: "gpt-6" },
      ]),
    });
    assert.strictEqual(implementer, "claude-opus-5,gpt-6");
  });

  it("ignores calls that did not finish, and compression calls", async () => {
    const implementer = await resolveImplementer({
      sessionId: "s1",
      events: events([
        { event_type: "provider_call", stop_reason: "error", model_id: "gpt-6" },
        {
          event_type: "provider_call",
          stop_reason: "stop",
          model_id: "claude-opus-5",
          provider_call_purpose: "context_compression",
        },
        { event_type: "tool_call", model_id: "gpt-6" },
      ]),
    });
    assert.strictEqual(implementer, undefined);
  });

  it("yields nothing for a session that ran no model", async () => {
    const implementer = await resolveImplementer({
      sessionId: "s1",
      events: events([]),
    });
    assert.strictEqual(implementer, undefined);
  });

  it("reads this session's own events, oldest first, in one page", async () => {
    const reader = events([
      {
        event_type: "model_response",
        stop_reason: "stop",
        model_id: "claude-opus-5",
      },
    ]);
    await resolveImplementer({ sessionId: "session-7", events: reader });
    const query = reader.queries[0]!;
    assert.strictEqual(query.sessionId, "session-7");
    assert.strictEqual(query.order, "asc");
    assert.strictEqual(query.limit, EVENT_PAGE_SIZE);
  });
});

describe("publish implementer: the whole scan", () => {
  it("reads past the first page until an answer comes back short", async () => {
    const reader = sized([EVENT_PAGE_SIZE, EVENT_PAGE_SIZE * 2, 3]);
    const implementer = await resolveImplementer({
      sessionId: "s1",
      events: reader,
    });
    assert.strictEqual(implementer, "claude-opus-5");
    assert.deepStrictEqual(reader.limits, [
      EVENT_PAGE_SIZE,
      EVENT_PAGE_SIZE * 2,
      EVENT_PAGE_SIZE * 4,
    ]);
  });

  it("refuses rather than reporting part of an oversized log", async () => {
    const reader = {
      bySession: (query: { limit: number }) =>
        Promise.resolve(
          Array.from({ length: query.limit }, () => ({
            event_type: "model_response",
            stop_reason: "stop",
            model_id: "claude-opus-5",
          })) as never,
        ),
      exists: () => Promise.resolve(false),
      countBySession: () => Promise.resolve(0),
      latestRun: () => Promise.resolve(null),
    } as unknown as EventReader;
    await assert.rejects(
      resolveImplementer({ sessionId: "s1", events: reader }),
      /stops at 200000/,
    );
  });
});
