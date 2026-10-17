// The runtime's lifetime owner: it counts connected clients for every
// runtime, and stops an autostarted one after a grace once the last client
// has gone. Timers are a fake the test advances, so the 10 s grace runs
// instantly.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AUTOSTARTED_IDLE_GRACE_MS,
  type LifetimeTimers,
  RuntimeLifetime,
} from "./lifetime.ts";

class FakeTimers implements LifetimeTimers {
  now = 0;
  #next = 1;
  readonly #pending = new Map<number, { at: number; fn: () => void }>();

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.#next++;
    this.#pending.set(id, { at: this.now + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#pending.delete(handle as number);
  }

  get pending(): number {
    return this.#pending.size;
  }

  /** Moves time forward, firing each timer that comes due, in order. */
  advance(ms: number): void {
    const until = this.now + ms;
    for (;;) {
      const due = [...this.#pending.entries()]
        .filter(([, timer]) => timer.at <= until)
        .sort(([, a], [, b]) => a.at - b.at)[0];
      if (due === undefined) break;
      const [id, timer] = due;
      this.#pending.delete(id);
      this.now = timer.at;
      timer.fn();
    }
    this.now = until;
  }
}

function lifetime(
  options: { autostarted: boolean; inFlightTurns?: () => number },
) {
  const timers = new FakeTimers();
  const idle: number[] = [];
  const owner = new RuntimeLifetime({
    autostarted: options.autostarted,
    inFlightTurns: options.inFlightTurns ?? (() => 0),
    onIdle: () => idle.push(timers.now),
    timers,
  });
  return { owner, timers, idle };
}

describe("RuntimeLifetime", () => {
  it("uses a 10 s grace", () => {
    assert.equal(AUTOSTARTED_IDLE_GRACE_MS, 10_000);
  });

  it("stops an autostarted runtime 10 s after its last client disconnects", () => {
    const { owner, timers, idle } = lifetime({ autostarted: true });
    owner.start();
    owner.clientsChanged(1);
    timers.advance(60_000);
    assert.deepEqual(idle, []);
    owner.clientsChanged(0);
    timers.advance(AUTOSTARTED_IDLE_GRACE_MS - 1);
    assert.deepEqual(idle, []);
    timers.advance(1);
    assert.deepEqual(idle, [60_000 + AUTOSTARTED_IDLE_GRACE_MS]);
  });

  it("a client connecting inside the grace cancels the shutdown", () => {
    const { owner, timers, idle } = lifetime({ autostarted: true });
    owner.start();
    owner.clientsChanged(1);
    owner.clientsChanged(0);
    timers.advance(9_000);
    owner.clientsChanged(1);
    timers.advance(60_000);
    assert.deepEqual(idle, []);
    assert.equal(timers.pending, 0);
    // The grace restarts from the next disconnect, in full.
    owner.clientsChanged(0);
    timers.advance(AUTOSTARTED_IDLE_GRACE_MS);
    assert.deepEqual(idle, [69_000 + AUTOSTARTED_IDLE_GRACE_MS]);
  });

  it("an autostarted runtime that no client ever reaches stops after the grace", () => {
    const { owner, timers, idle } = lifetime({ autostarted: true });
    owner.start();
    timers.advance(AUTOSTARTED_IDLE_GRACE_MS);
    assert.deepEqual(idle, [AUTOSTARTED_IDLE_GRACE_MS]);
  });

  it("waits for an in-flight turn before stopping, then grants a fresh grace", () => {
    let turns = 1;
    const { owner, timers, idle } = lifetime({
      autostarted: true,
      inFlightTurns: () => turns,
    });
    owner.start();
    owner.clientsChanged(1);
    owner.clientsChanged(0);
    timers.advance(AUTOSTARTED_IDLE_GRACE_MS);
    assert.deepEqual(idle, []);
    turns = 0;
    timers.advance(AUTOSTARTED_IDLE_GRACE_MS);
    assert.deepEqual(idle, [2 * AUTOSTARTED_IDLE_GRACE_MS]);
  });

  it("fires its idle callback once", () => {
    const { owner, timers, idle } = lifetime({ autostarted: true });
    owner.start();
    timers.advance(AUTOSTARTED_IDLE_GRACE_MS);
    owner.clientsChanged(1);
    owner.clientsChanged(0);
    timers.advance(AUTOSTARTED_IDLE_GRACE_MS * 3);
    assert.equal(idle.length, 1);
  });

  it("never stops a runtime started with dyfj start, but still counts its clients", () => {
    const { owner, timers, idle } = lifetime({ autostarted: false });
    owner.start();
    owner.clientsChanged(2);
    assert.equal(owner.clients, 2);
    owner.clientsChanged(0);
    timers.advance(AUTOSTARTED_IDLE_GRACE_MS * 10);
    assert.deepEqual(idle, []);
    assert.equal(timers.pending, 0);
    assert.equal(owner.clients, 0);
  });

  it("dispose cancels a pending shutdown", () => {
    const { owner, timers, idle } = lifetime({ autostarted: true });
    owner.start();
    owner.dispose();
    timers.advance(AUTOSTARTED_IDLE_GRACE_MS * 2);
    assert.deepEqual(idle, []);
  });
});
