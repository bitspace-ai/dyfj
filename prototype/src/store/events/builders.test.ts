import { assertEquals } from "@std/assert";
import { EVENT_TYPE_VALUES, type EventType } from "../generated/rows.ts";
import {
  EVENT_BUILDERS,
  type EventFields,
  modelSelectedEvent,
  sessionStartEvent,
  toolCallEvent,
} from "./builders.ts";

const base: EventFields = {
  event_id: "EV1",
  session_id: "S1",
  trace_id: "trace",
  span_id: "span",
  principal_id: "operator",
  principal_type: "human",
  action: "start",
  resource: "workbench_session",
  authz_basis: "test",
};

Deno.test("every event type has exactly one builder", () => {
  assertEquals(
    Object.keys(EVENT_BUILDERS).sort(),
    [...EVENT_TYPE_VALUES].sort(),
  );
});

Deno.test("each builder sets its own event_type", () => {
  for (const eventType of EVENT_TYPE_VALUES) {
    const build = EVENT_BUILDERS[eventType] as unknown as (
      fields: EventFields,
    ) => { event_type: EventType };
    const built = build({
      ...base,
      content: "c",
      model_id: "m",
      provider_call_order: 1,
      provider_call_purpose: "initial",
      tool_name: "t",
      tool_call_id: "tc",
      runner_kind: "external_agent",
      runner_profile: "fixture",
      permission_verdict: "approved",
    });
    assertEquals(built.event_type, eventType);
  }
});

Deno.test("a builder writes exactly the fields it was given, nulls included", () => {
  const fields = {
    ...base,
    parent_span_id: null,
    content: "prompt",
    duration_ms: undefined,
  };
  assertEquals(sessionStartEvent(fields), {
    ...fields,
    event_type: "session_start",
  });
});

Deno.test("a builder's event_type wins over a stray one in the fields", () => {
  // Not a fresh literal, so the stray column passes the compile-time check.
  const stray = { ...base, event_type: "error", content: "{}" };
  assertEquals(modelSelectedEvent(stray).event_type, "model_selected");
  assertEquals(
    toolCallEvent({ ...base, tool_name: "read_file", tool_call_id: "c1" })
      .event_type,
    "tool_call",
  );
});
