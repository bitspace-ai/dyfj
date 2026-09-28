import {
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import { ManualClock } from "../../testing/fakes/manual-clock.ts";
import { CeilingConfirmationStore } from "../budget/mod.ts";
import { SessionOwners, TurnTicket } from "./session-owner.ts";

const SESSION = "01ABCDEF0123456789ABCDEF01";

/** A turn body the test settles by hand, recording when it started. */
function heldTurn(log: string[], name: string) {
  let settle!: (value: string) => void;
  let fail!: (reason: unknown) => void;
  const done = new Promise<string>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  return {
    run: () => {
      log.push(`start ${name}`);
      return done;
    },
    finish: () => settle(name),
    fail: (reason: unknown) => fail(reason),
  };
}

/** Let queued promise reactions run. */
async function drain(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

Deno.test("same-session turns run one at a time, in arrival order", async () => {
  const owners = new SessionOwners();
  const log: string[] = [];
  const first = heldTurn(log, "first");
  const second = heldTurn(log, "second");

  const firstResult = owners.runTurn(SESSION, first.run);
  const secondResult = owners.runTurn(SESSION, second.run);
  await drain();
  assertEquals(log, ["start first"]);

  first.finish();
  assertEquals(await firstResult, "first");
  await drain();
  assertEquals(log, ["start first", "start second"]);
  second.finish();
  assertEquals(await secondResult, "second");
});

Deno.test("a rejected turn releases the lock to the next same-session turn", async () => {
  const owners = new SessionOwners();
  const log: string[] = [];
  const first = heldTurn(log, "first");
  const second = heldTurn(log, "second");

  const firstResult = owners.runTurn(SESSION, first.run);
  const secondResult = owners.runTurn(SESSION, second.run);
  first.fail(new Error("provider down"));
  await assertRejects(() => firstResult, Error, "provider down");
  await drain();
  assertEquals(log, ["start first", "start second"]);
  second.finish();
  assertEquals(await secondResult, "second");
});

Deno.test("new-session turns and turns on other sessions are not serialized", async () => {
  const owners = new SessionOwners();
  const log: string[] = [];
  const held = heldTurn(log, "held");
  const fresh = heldTurn(log, "fresh");
  const other = heldTurn(log, "other");

  const heldResult = owners.runTurn(SESSION, held.run);
  const freshResult = owners.runTurn(undefined, fresh.run);
  const otherResult = owners.runTurn("01OTHER0000000000000000000", other.run);
  await drain();
  // A new-session turn starts synchronously; queued turns start a microtask
  // later. None waits on another.
  assertEquals(log, ["start fresh", "start held", "start other"]);
  // The new session's owner is registered under its allocated id.
  assertEquals(owners.activeSessions, 3);

  held.finish();
  fresh.finish();
  other.finish();
  await Promise.all([heldResult, freshResult, otherResult]);
});

Deno.test("a new session's id is allocated at admission, so a later turn naming it queues behind it", async () => {
  const owners = new SessionOwners();
  const log: string[] = [];
  const first = heldTurn(log, "first");
  const second = heldTurn(log, "second");
  let allocated: string | undefined;

  const firstResult = owners.runTurn(undefined, (sessionId) => {
    allocated = sessionId;
    return first.run();
  });
  await drain();
  // The turn runs under a fresh ULID-shaped id.
  assertMatch(allocated ?? "", /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assertEquals(owners.activeSessions, 1);

  const secondResult = owners.runTurn(allocated, (sessionId) => {
    log.push(`second on ${sessionId === allocated ? "same" : "other"}`);
    return second.run();
  });
  await drain();
  assertEquals(log, ["start first"]);

  first.finish();
  assertEquals(await firstResult, "first");
  await drain();
  assertEquals(log, ["start first", "second on same", "start second"]);
  second.finish();
  assertEquals(await secondResult, "second");
  await drain();
  assertEquals(owners.activeSessions, 0);
});

Deno.test("each new-session turn gets its own id", async () => {
  const owners = new SessionOwners();
  const ids: string[] = [];
  await Promise.all([
    owners.runTurn(undefined, (id) => Promise.resolve(ids.push(id))),
    owners.runTurn(undefined, (id) => Promise.resolve(ids.push(id))),
  ]);
  assertEquals(ids.length, 2);
  assertNotEquals(ids[0], ids[1]);
});

Deno.test("an owner is dropped once its last turn settles, and a later turn starts fresh", async () => {
  const owners = new SessionOwners();
  const log: string[] = [];
  const first = heldTurn(log, "first");
  const second = heldTurn(log, "second");

  const firstResult = owners.runTurn(SESSION, first.run);
  const secondResult = owners.runTurn(SESSION, second.run);
  first.finish();
  await firstResult;
  await drain();
  // The second turn is still queued, so the owner stays.
  assertEquals(owners.activeSessions, 1);
  second.finish();
  await secondResult;
  await drain();
  assertEquals(owners.activeSessions, 0);

  const third = heldTurn(log, "third");
  const thirdResult = owners.runTurn(SESSION, third.run);
  await drain();
  assertEquals(log.at(-1), "start third");
  third.finish();
  await thirdResult;
});

Deno.test("a ticket's cancel aborts its signal once, then closes the window", () => {
  const ticket = new SessionOwners().admit();
  assertStrictEquals(ticket.signal.aborted, false);
  assertStrictEquals(ticket.cancel(), true);
  assertStrictEquals(ticket.signal.aborted, true);
  assertStrictEquals(ticket.cancel(), false);
});

Deno.test("a ticket declines cancel after the runtime closes its window", () => {
  const ticket = new TurnTicket();
  ticket.closeCancellation();
  assertStrictEquals(ticket.cancel(), false);
  assertStrictEquals(ticket.signal.aborted, false);
});

Deno.test("an interrupted approval aborts the turn even after the window closes", () => {
  const ticket = new TurnTicket();
  ticket.closeCancellation();
  ticket.abort();
  assertStrictEquals(ticket.signal.aborted, true);
});

Deno.test("each admitted turn gets its own cancel signal", () => {
  const owners = new SessionOwners();
  const a = owners.admit();
  const b = owners.admit();
  a.cancel();
  assertStrictEquals(a.signal.aborted, true);
  assertStrictEquals(b.signal.aborted, false);
});

Deno.test("a session's budget scope keeps its marks across turns; the daily mark is shared", () => {
  const confirmations = new CeilingConfirmationStore(new ManualClock());
  const owners = new SessionOwners(confirmations);
  owners.budgetScope(SESSION).session_limit = 5;
  owners.budgetScope(SESSION).daily_limit = 9;
  assertEquals(owners.budgetScope(SESSION).session_limit, 5);
  const other = owners.budgetScope("01OTHER0000000000000000000");
  assertEquals(other.session_limit, undefined);
  assertEquals(other.daily_limit, 9);
});
