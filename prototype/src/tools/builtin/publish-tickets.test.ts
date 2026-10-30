import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  branchOf,
  MAX_TICKETS_PER_SESSION,
  MAX_TICKETS_TOTAL,
  PublishTickets,
} from "./publish-tickets.ts";
import type { GitLayout } from "./publish-git.ts";

/** The commit the fixture branch is on, as a definite id for the head checks. */
const HEAD = "0123456789abcdef0123456789abcdef01234567";

const LAYOUT: GitLayout = {
  gitDir: "/repo/.git/worktrees/bit-786",
  commonDir: "/repo/.git",
  topLevel: "/repo",
  branchRef: "refs/heads/chris/bit-786-host-publish-tool",
  head: HEAD,
};

function registry(options: { ttlMs?: number; now?: () => number } = {}) {
  let now = 1_000;
  const tickets = new PublishTickets({
    ttlMs: options.ttlMs ?? 60_000,
    now: options.now ?? (() => now),
  });
  return {
    tickets,
    advance(ms: number) {
      now += ms;
    },
  };
}

function create(
  tickets: PublishTickets,
  overrides: { sessionId?: string; layout?: GitLayout } = {},
) {
  return tickets.create({
    sessionId: overrides.sessionId ?? "s1",
    layout: overrides.layout ?? LAYOUT,
    reportPathFor: (ticket) => `/tmp/report-${ticket}.log`,
  });
}

describe("publish tickets: creation", () => {
  it("pins the resolved repository, branch and commit", () => {
    const { tickets } = registry();
    const view = create(tickets);
    assert.strictEqual(view.phase, "pre-gate");
    assert.strictEqual(view.repository, LAYOUT.topLevel);
    assert.strictEqual(view.branch, "chris/bit-786-host-publish-tool");
    assert.strictEqual(view.head, HEAD);
    assert.match(view.reportPath, new RegExp(`/tmp/report-${view.ticket}\\.log`));
  });

  it("reports a detached head as no branch", () => {
    const { tickets } = registry();
    const view = create(tickets, {
      layout: { ...LAYOUT, branchRef: null },
    });
    assert.strictEqual(view.branch, null);
    assert.strictEqual(branchOf({ ...LAYOUT, branchRef: "refs/tags/v1" }), null);
  });

  it("keeps the newest tickets and drops the oldest", () => {
    const { tickets } = registry();
    for (let index = 0; index < MAX_TICKETS_PER_SESSION + 2; index++) {
      create(tickets);
    }
    assert.strictEqual(tickets.list("s1").length, MAX_TICKETS_PER_SESSION);
  });

  it("keeps sessions apart", () => {
    const { tickets } = registry();
    const mine = create(tickets, { sessionId: "s1" });
    assert.strictEqual(tickets.get("s2", mine.ticket), null);
    assert.strictEqual(tickets.latest("s2"), null);
    assert.ok(tickets.get("s1", mine.ticket) !== null);
  });
});

describe("publish tickets: transitions", () => {
  it("runs pre-gate, gated, ready in order and refuses steps out of order", () => {
    const { tickets } = registry();
    const view = create(tickets);
    assert.strictEqual(tickets.markReady("s1", view.ticket), null);
    assert.strictEqual(tickets.markGated("s1", view.ticket)?.phase, "gated");
    assert.strictEqual(tickets.markGated("s1", view.ticket), null);
    assert.strictEqual(tickets.markReady("s1", view.ticket)?.phase, "ready");
  });

  it("records a failed phase with its reason and output tail", () => {
    const { tickets } = registry();
    const view = create(tickets);
    const failed = tickets.markFailed(
      "s1",
      view.ticket,
      "gate",
      "the gate exited 1",
      "first failing test",
      true,
    );
    assert.strictEqual(failed?.phase, "failed");
    assert.strictEqual(failed?.failedPhase, "gate");
    assert.strictEqual(failed?.reason, "the gate exited 1");
    assert.strictEqual(failed?.outputHead, "first failing test");
    assert.strictEqual(failed?.truncatedOutput, true);
    // A failed ticket never becomes ready.
    assert.strictEqual(tickets.markReady("s1", view.ticket), null);
  });

  it("cancels a running phase and reports which one", () => {
    const { tickets } = registry();
    const view = create(tickets);
    let stops = 0;
    tickets.attachCancelHook("s1", view.ticket, () => {
      stops += 1;
    });
    const cancelled = tickets.cancel("s1", view.ticket);
    assert.strictEqual(stops, 1);
    assert.strictEqual(cancelled?.phase, "failed");
    assert.strictEqual(cancelled?.failedPhase, "pre-gate");
    assert.match(cancelled?.reason ?? "", /cancelled/);
    // Cancelling again is a no-op: the run is already stopped.
    assert.strictEqual(tickets.cancel("s1", view.ticket), null);
  });

  it("cancels a gate as the gate's failure, not the pre-gate's", () => {
    const { tickets } = registry();
    const view = create(tickets);
    tickets.markGated("s1", view.ticket);
    assert.strictEqual(
      tickets.cancel("s1", view.ticket)?.failedPhase,
      "gate",
    );
  });

  it("marks a refused approval dead", () => {
    const { tickets } = registry();
    const view = create(tickets);
    tickets.markGated("s1", view.ticket);
    tickets.markReady("s1", view.ticket);
    assert.strictEqual(tickets.markDenied("s1", view.ticket)?.phase, "denied");
    assert.strictEqual(tickets.markPushing("s1", view.ticket, HEAD), null);
  });
});

describe("publish tickets: the head is the approval", () => {
  it("pushes only the pinned head", () => {
    const { tickets } = registry();
    const view = create(tickets);
    tickets.markGated("s1", view.ticket);
    tickets.markReady("s1", view.ticket);
    const pushed = tickets.markPushing(
      "s1",
      view.ticket,
      "1111111111111111111111111111111111111111",
    );
    assert.strictEqual(pushed?.phase, "expired");
    assert.match(pushed?.reason ?? "", /head moved/);
  });

  it("allows one push per ticket", () => {
    const { tickets } = registry();
    const view = create(tickets);
    tickets.markGated("s1", view.ticket);
    tickets.markReady("s1", view.ticket);
    assert.strictEqual(
      tickets.markPushing("s1", view.ticket, HEAD)?.phase,
      "pushing",
    );
    assert.strictEqual(tickets.markPushing("s1", view.ticket, HEAD), null);
    assert.strictEqual(tickets.markPushing("s1", view.ticket, HEAD), null);
    assert.strictEqual(tickets.markPushed("s1", view.ticket)?.phase, "pushed");
    assert.strictEqual(tickets.markPrOpen("s1", view.ticket)?.phase, "pr-open");
  });
});

describe("publish tickets: lifetime", () => {
  it("expires a ticket past its TTL, reporting why", () => {
    const { tickets, advance } = registry({ ttlMs: 5_000 });
    const view = create(tickets);
    assert.strictEqual(tickets.get("s1", view.ticket)?.phase, "pre-gate");
    advance(5_001);
    const expired = tickets.get("s1", view.ticket);
    assert.strictEqual(expired?.phase, "expired");
    assert.match(expired?.reason ?? "", /outlived/);
    assert.strictEqual(tickets.markGated("s1", view.ticket), null);
  });

  it("stops the run of a ticket that expires", () => {
    const { tickets, advance } = registry({ ttlMs: 1_000 });
    const view = create(tickets);
    let stops = 0;
    tickets.attachCancelHook("s1", view.ticket, () => {
      stops += 1;
    });
    advance(1_001);
    tickets.expireStale();
    assert.strictEqual(stops, 1);
  });

  it("reports unknown for a ticket this registry does not hold", () => {
    const { tickets } = registry();
    assert.strictEqual(
      tickets.get("s1", "00000000-0000-0000-0000-000000000000"),
      null,
    );
  });
});

describe("publish tickets: what the registry keeps", () => {
  it("stops the run of a ticket it evicts", () => {
    const { tickets } = registry();
    const stops: string[] = [];
    for (let index = 0; index < MAX_TICKETS_PER_SESSION; index++) {
      const view = create(tickets);
      tickets.attachCancelHook("s1", view.ticket, () => stops.push(view.ticket));
    }
    // One more than the session may retain: the oldest goes, and its run stops.
    create(tickets);
    assert.strictEqual(stops.length, 1);
    assert.strictEqual(tickets.list("s1").length, MAX_TICKETS_PER_SESSION);
  });

  it("bounds the whole registry across sessions", () => {
    const { tickets } = registry();
    const sessions = Math.ceil(MAX_TICKETS_TOTAL / MAX_TICKETS_PER_SESSION) + 2;
    for (let index = 0; index < sessions; index++) {
      for (let n = 0; n < MAX_TICKETS_PER_SESSION; n++) {
        create(tickets, { sessionId: `s${index}` });
      }
    }
    const total = Array.from({ length: sessions }, (_, index) =>
      tickets.list(`s${index}`).length
    ).reduce((sum, count) => sum + count, 0);
    assert.ok(total <= MAX_TICKETS_TOTAL, `${total} tickets retained`);
    // The newest session survives; the oldest went first.
    assert.ok(tickets.list("s0").length < MAX_TICKETS_PER_SESSION);
  });

  it("sweeps expired tickets and the session maps they empty", () => {
    const { tickets, advance } = registry({ ttlMs: 1_000 });
    const view = create(tickets, { sessionId: "gone" });
    advance(2_000);
    // Expiry alone keeps the record: status still has something to report.
    assert.strictEqual(tickets.get("gone", view.ticket)?.phase, "expired");
    assert.strictEqual(tickets.sweep(), 1);
    assert.strictEqual(tickets.get("gone", view.ticket), null);
    assert.deepStrictEqual(tickets.list("gone"), []);
    assert.strictEqual(tickets.sweep(), 0);
  });
});

describe("publish tickets: expiry and the total bound", () => {
  it("drops expired tickets before it evicts a live one", () => {
    const { tickets, advance } = registry({ ttlMs: 1_000 });
    create(tickets, { sessionId: "old" });
    advance(2_000);
    // Fill the registry to its total bound: the expired ticket is reaped
    // first, so no live ticket that could still be approved is evicted.
    const perSession = MAX_TICKETS_PER_SESSION;
    const sessions = MAX_TICKETS_TOTAL / perSession;
    for (let s = 0; s < sessions; s++) {
      for (let n = 0; n < perSession; n++) {
        create(tickets, { sessionId: `new-${s}` });
      }
    }
    assert.deepStrictEqual(tickets.list("old"), []);
    let total = 0;
    for (let s = 0; s < sessions; s++) total += tickets.list(`new-${s}`).length;
    assert.strictEqual(total, MAX_TICKETS_TOTAL);
  });

  it("marks and then forgets in one call", () => {
    const { tickets, advance } = registry({ ttlMs: 1_000 });
    create(tickets, { sessionId: "s1" });
    advance(2_000);
    assert.strictEqual(tickets.expireStale(), 1);
    assert.deepStrictEqual(tickets.list("s1"), []);
  });
});

describe("publish tickets: integrity", () => {
  it("copies the pinned layout in and out", () => {
    const { tickets } = registry();
    const layout = { ...LAYOUT };
    const view = create(tickets, { layout });
    layout.head = "f".repeat(40);
    view.layout.head = "e".repeat(40);
    const again = tickets.get("s1", view.ticket);
    assert.strictEqual(again?.layout.head, HEAD);
  });

  it("does not let a late failure overwrite an expired ticket", () => {
    const { tickets, advance } = registry({ ttlMs: 1_000 });
    const view = create(tickets);
    advance(2_000);
    assert.strictEqual(tickets.get("s1", view.ticket)?.phase, "expired");
    assert.strictEqual(
      tickets.markFailed("s1", view.ticket, "gate", "late", "", false),
      null,
    );
    const after = tickets.get("s1", view.ticket);
    assert.strictEqual(after?.phase, "expired");
    assert.strictEqual(after?.reason, "the ticket outlived its lifetime");
  });

  it("changes state even when a cancel hook throws", () => {
    const { tickets } = registry();
    const view = create(tickets);
    assert.ok(tickets.attachCancelHook("s1", view.ticket, () => {
      throw new Error("stopper failed");
    }));
    const cancelled = tickets.cancel("s1", view.ticket);
    assert.strictEqual(cancelled?.phase, "failed");
    assert.strictEqual(cancelled?.reason, "cancelled by the operator");
  });

  it("keeps the session bound when an evicted ticket's hook throws", () => {
    const { tickets } = registry();
    for (let index = 0; index < MAX_TICKETS_PER_SESSION; index += 1) {
      const view = create(tickets);
      tickets.attachCancelHook("s1", view.ticket, () => {
        throw new Error("stopper failed");
      });
    }
    create(tickets);
    assert.strictEqual(tickets.list("s1").length, MAX_TICKETS_PER_SESSION);
  });

  it("expires stale tickets in every session before evicting for the total bound", () => {
    const { tickets, advance } = registry({ ttlMs: 10_000 });
    let stopped = 0;
    // Old running tickets in many idle sessions, past their TTL but not yet
    // marked: nothing has looked at those sessions since.
    for (let index = 0; index < MAX_TICKETS_TOTAL; index += 1) {
      const view = create(tickets, { sessionId: `idle-${index}` });
      tickets.attachCancelHook(`idle-${index}`, view.ticket, () => {
        stopped += 1;
      });
    }
    advance(20_000);
    const fresh = create(tickets, { sessionId: "active" });
    assert.strictEqual(tickets.get("active", fresh.ticket)?.phase, "pre-gate");
    // Every stale run was stopped by expiry, not just the one eviction needed.
    assert.strictEqual(stopped, MAX_TICKETS_TOTAL);
  });
});
