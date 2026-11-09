import assert from "node:assert/strict";
import { test } from "node:test";
import type { EventInsert } from "../store/mod.ts";
import { ParkedApprovals } from "./parked-approvals.ts";

const at = { sessionId: "S1", traceId: "T1" };
const toolRequest = {
  commandId: "bash",
  callId: "c1",
  title: "Run a command",
  arguments: { command: "touch x" },
};

function registry(options: { timeoutMs?: number; failWrites?: boolean } = {}) {
  const events: EventInsert[] = [];
  const parked = new ParkedApprovals({
    writeEvent: (event) => {
      if (options.failWrites) return Promise.reject(new Error("store down"));
      events.push(event);
      return Promise.resolve();
    },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return { parked, events };
}

// The park writes its event before the request is listed, so wait for it.
async function untilPending(parked: ParkedApprovals, sessionId: string) {
  for (let i = 0; i < 100; i++) {
    const pending = parked.pending(sessionId);
    if (pending.length > 0) return pending;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("nothing was parked");
}

test("a parked request is listed for its session and records approval_parked", async () => {
  const { parked, events } = registry();
  const answer = parked.park(at, toolRequest);
  const [pending] = await untilPending(parked, "S1");
  assert.deepStrictEqual(pending!.request, toolRequest);
  assert.match(pending!.approvalId, /^[0-9a-f-]{36}$/);
  assert.deepStrictEqual(parked.pending("S2"), []);
  assert.ok(parked.hasPending("S1"));
  assert.ok(!parked.hasPending("S2"));

  const [event] = events;
  assert.equal(event!.event_type, "approval_parked");
  assert.equal(event!.session_id, "S1");
  assert.equal(event!.trace_id, "T1");
  assert.equal(event!.resource, pending!.approvalId);
  assert.equal(event!.tool_name, "bash");
  // The request's arguments stay in memory; the log names the kind only.
  assert.deepStrictEqual(JSON.parse(String(event!.content)), {
    approvalId: pending!.approvalId,
    kind: "tool",
  });
  assert.ok(!JSON.stringify(event).includes("touch x"));

  assert.equal(
    await parked.answer("S1", pending!.approvalId, { decision: "approve" }),
    true,
  );
  assert.deepStrictEqual(await answer, { decision: "approve" });
  assert.deepStrictEqual(parked.pending("S1"), []);
  const resolved = events[1]!;
  assert.equal(resolved.event_type, "approval_resolved");
  assert.equal(resolved.permission_verdict, "approved");
  assert.equal(resolved.principal_type, "human");
});

test("an answer for an id that is not pending for that session is refused", async () => {
  const { parked } = registry();
  const answer = parked.park(at, toolRequest);
  const [pending] = await untilPending(parked, "S1");
  assert.equal(
    await parked.answer("S1", crypto.randomUUID(), { decision: "approve" }),
    false,
  );
  // The right id under another session is not pending there either.
  assert.equal(
    await parked.answer("S2", pending!.approvalId, { decision: "approve" }),
    false,
  );
  assert.equal(parked.pending("S1").length, 1);
  await parked.answer("S1", pending!.approvalId, { decision: "deny" });
  assert.deepStrictEqual(await answer, { decision: "deny" });
});

test("a second answer for the same approval is refused", async () => {
  const { parked, events } = registry();
  const answer = parked.park(at, toolRequest);
  const [pending] = await untilPending(parked, "S1");
  const first = parked.answer("S1", pending!.approvalId, { decision: "deny" });
  const second = parked.answer("S1", pending!.approvalId, {
    decision: "approve",
  });
  assert.equal(await first, true);
  assert.equal(await second, false);
  assert.deepStrictEqual(await answer, { decision: "deny" });
  assert.equal(
    events.filter((event) => event.event_type === "approval_resolved").length,
    1,
  );
});

test("a park that times out denies, and records the timeout", async () => {
  const { parked, events } = registry({ timeoutMs: 5 });
  const response = await parked.park(at, toolRequest) as {
    decision: string;
    reason: string;
  };
  assert.equal(response.decision, "deny");
  assert.match(response.reason, /timed out/);
  assert.deepStrictEqual(parked.pending("S1"), []);
  const resolved = events.find((e) => e.event_type === "approval_resolved")!;
  assert.equal(resolved.permission_verdict, "denied");
  assert.equal(resolved.principal_type, "service");
});

test("a cancelled turn's park is withdrawn and rejects with the turn's reason", async () => {
  const { parked, events } = registry();
  const controller = new AbortController();
  const answer = parked.park(at, toolRequest, controller.signal);
  const [pending] = await untilPending(parked, "S1");
  const reason = new Error("cancelled");
  controller.abort(reason);
  await assert.rejects(answer, (error) => error === reason);
  assert.deepStrictEqual(parked.pending("S1"), []);
  assert.equal(
    await parked.answer("S1", pending!.approvalId, { decision: "approve" }),
    false,
  );
  const resolved = events.find((e) => e.event_type === "approval_resolved")!;
  assert.equal(resolved.permission_verdict, "cancelled");
});

test("a request that cannot be recorded is not parked", async () => {
  const { parked } = registry({ failWrites: true });
  await assert.rejects(parked.park(at, toolRequest));
  assert.deepStrictEqual(parked.pending("S1"), []);
});

test("an ACP answer's verdict is read from the option it selects", async () => {
  const { parked, events } = registry();
  const request = {
    kind: "external_agent_permission",
    title: "Edit a file",
    options: [
      { optionId: "yes", name: "Allow", kind: "allow_once" },
      { optionId: "no", name: "Reject", kind: "reject_once" },
    ],
  };
  const answer = parked.park(at, request);
  const [pending] = await untilPending(parked, "S1");
  await parked.answer("S1", pending!.approvalId, {
    decision: "select",
    optionId: "no",
  });
  await answer;
  const parkedEvent = events[0]!;
  assert.equal(
    JSON.parse(String(parkedEvent.content)).kind,
    "external_agent_permission",
  );
  assert.equal(events[1]!.permission_verdict, "denied");
});

test("an ACP permission answered with a bare approve is recorded as denied", async () => {
  const { parked, events } = registry();
  const request = {
    kind: "external_agent_permission",
    title: "Edit a file",
    options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }],
  };
  const answer = parked.park(at, request);
  const [pending] = await untilPending(parked, "S1");
  // The ACP parser rejects this shape; the log must agree with it.
  parked.answer("S1", pending!.approvalId, { decision: "approve" });
  await answer;
  assert.equal(events[1]!.permission_verdict, "denied");
});

// A write the test releases by hand, to hold the log mid-write.
function heldWrites() {
  const events: EventInsert[] = [];
  const held: { event: EventInsert; release: () => void }[] = [];
  const writeEvent = (event: EventInsert) =>
    new Promise<void>((resolve) => {
      held.push({
        event,
        release: () => {
          events.push(event);
          resolve();
        },
      });
    });
  return { events, held, writeEvent };
}

test("a turn cancelled while its park is being recorded is not held by the write", async () => {
  const writes = heldWrites();
  const parked = new ParkedApprovals({ writeEvent: writes.writeEvent });
  const controller = new AbortController();
  const answer = parked.park(at, toolRequest, controller.signal);
  const reason = new Error("cancelled");
  controller.abort(reason);
  await assert.rejects(answer, (error) => error === reason);
  assert.deepStrictEqual(parked.pending("S1"), []);
  // The park's record lands late; its end is recorded after it.
  writes.held[0]!.release();
  for (let i = 0; i < 10 && writes.held.length < 2; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  writes.held[1]!.release();
  assert.deepStrictEqual(
    writes.events.map((e) => [e.event_type, e.permission_verdict ?? null]),
    [["approval_parked", null], ["approval_resolved", "cancelled"]],
  );
});

test("the timeout also bounds a park whose record never lands", async () => {
  const writes = heldWrites();
  const parked = new ParkedApprovals({
    writeEvent: writes.writeEvent,
    timeoutMs: 5,
  });
  const response = await parked.park(at, toolRequest) as { decision: string };
  assert.equal(response.decision, "deny");
  assert.deepStrictEqual(parked.pending("S1"), []);
});

test("an answer does not wait for its resolution record", async () => {
  let writes = 0;
  const parked = new ParkedApprovals({
    // The park records; the resolution write never settles.
    writeEvent: () => writes++ === 0 ? Promise.resolve() : new Promise(() => {}),
  });
  const answer = parked.park(at, toolRequest);
  const [pending] = await untilPending(parked, "S1");
  parked.answer("S1", pending!.approvalId, { decision: "approve" });
  assert.deepStrictEqual(await answer, { decision: "approve" });
});

test("a session counts as waiting while its park is still being recorded", async () => {
  const writes = heldWrites();
  const parked = new ParkedApprovals({ writeEvent: writes.writeEvent });
  const answer = parked.park(at, toolRequest);
  await new Promise((resolve) => setImmediate(resolve));
  // Not listed yet, but a turn naming the session must already be refused.
  assert.deepStrictEqual(parked.pending("S1"), []);
  assert.ok(parked.hasPending("S1"));
  writes.held[0]!.release();
  const [pending] = await untilPending(parked, "S1");
  parked.answer("S1", pending!.approvalId, { decision: "deny" });
  await answer;
  assert.ok(!parked.hasPending("S1"));
});
