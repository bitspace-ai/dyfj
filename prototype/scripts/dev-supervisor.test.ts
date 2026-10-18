import assert from "node:assert/strict";
import { test } from "node:test";
import type { BatchClass } from "./dev-classify.ts";
import type { SnapshotCheck } from "./dev-snapshot.ts";
import {
  DEBOUNCE_MS,
  DevSupervisor,
  type DevPorts,
  IN_FLIGHT_POLL_MS,
} from "./dev-supervisor.ts";

/** A clock that runs timers only when the test advances it. */
class FakeClock {
  now = 0;
  #timers = new Map<number, { at: number; fn: () => void }>();
  #next = 1;
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = this.#next++;
    this.#timers.set(id, { at: this.now + ms, fn });
    return id;
  };
  clearTimeout = (handle: unknown): void => {
    this.#timers.delete(handle as number);
  };
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      await settle();
      const due = [...this.#timers.entries()]
        .filter(([, t]) => t.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.#timers.delete(due[0]);
      this.now = due[1].at;
      due[1].fn();
    }
    this.now = end;
    await settle();
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

type Classify = (paths: readonly string[]) => BatchClass;

function harness(options: {
  classify?: Classify;
  inFlight?: number[];
  build?: { ok: true } | { ok: false; error: string };
  boot?: ("ready" | string)[];
  /** What each snapshot check finds; `none` once the list runs out. */
  snapshot?: SnapshotCheck[];
  /** How each start of the last good code goes. */
  lastGood?: ("ready" | string)[];
} = {}) {
  const clock = new FakeClock();
  const log: string[] = [];
  const lines: string[] = [];
  const batches: string[][] = [];
  const inFlight = [...(options.inFlight ?? [])];
  const boots = [...(options.boot ?? [])];
  const snapshots = [...(options.snapshot ?? [])];
  const lastGood = [...(options.lastGood ?? [])];
  const blocks: string[] = [];
  const promotions: string[] = [];
  let build = options.build ?? { ok: true as const };
  const ports: DevPorts = {
    clock,
    classify: (paths) => {
      batches.push([...paths]);
      return options.classify?.(paths) ??
        { runtime: true, repl: false, files: paths.length };
    },
    runtime: {
      start: async () => {
        log.push("runtime.start");
        const next = boots.shift() ?? "ready";
        return next === "ready"
          ? { ok: true, contentHash: "sha256:tree" }
          : { ok: false, error: next, detail: `log: ${next}` };
      },
      startLastGood: async (failure) => {
        log.push("runtime.startLastGood");
        blocks.push(failure);
        const next = lastGood.shift() ?? "ready";
        return next === "ready" ? { ok: true, contentHash: "sha256:good" } : { ok: false, error: next };
      },
      stop: async () => {
        log.push("runtime.stop");
      },
      inFlightTurns: async () => inFlight.length > 0 ? inFlight.shift()! : 0,
    },
    repl: {
      launch: (session, reloaded) => {
        log.push(`repl.launch ${session ?? "-"}${reloaded === undefined ? "" : ` [${reloaded}]`}`);
      },
      exit: async () => {
        log.push("repl.exit");
      },
      notify: (message) => {
        log.push(`repl.notify ${message.reason}${message.replaced === true ? " (replaced)" : ""}`);
      },
    },
    build: async () => {
      log.push("build");
      return build;
    },
    snapshot: {
      check: async () => snapshots.shift() ?? { ok: false, reason: "none" },
      promote: async (hash) => {
        promotions.push(hash);
        return { ok: true };
      },
    },
    report: (line) => lines.push(line),
  };
  const supervisor = new DevSupervisor(ports);
  return {
    clock,
    log,
    lines,
    batches,
    blocks,
    promotions,
    supervisor,
    setBuild(next: typeof build) {
      build = next;
    },
  };
}

test("saves are debounced: one batch, 300 ms after the last save", async () => {
  const h = harness();
  assert.deepStrictEqual(DEBOUNCE_MS, 300);
  h.supervisor.changed("prototype/src/a.ts");
  await h.clock.advance(200);
  h.supervisor.changed("prototype/src/b.ts");
  await h.clock.advance(200);
  h.supervisor.changed("prototype/src/a.ts");
  await h.clock.advance(299);
  assert.deepStrictEqual(h.batches, []);
  await h.clock.advance(1);
  assert.deepStrictEqual(h.batches, [["prototype/src/a.ts", "prototype/src/b.ts"]]);
  assert.deepStrictEqual(h.log, [
    "repl.notify 2 files changed",
    "runtime.stop",
    "runtime.start",
  ]);
});

test("a batch that needs nothing restarts nothing", async () => {
  const h = harness({ classify: (p) => ({ runtime: false, repl: false, files: p.length }) });
  h.supervisor.changed("prototype/src/a.test.ts");
  await h.clock.advance(DEBOUNCE_MS);
  assert.deepStrictEqual(h.log, []);
});

test("a runtime reload waits while a turn is in flight", async () => {
  const h = harness({ inFlight: [1, 2] });
  h.supervisor.changed("prototype/src/a.ts");
  await h.clock.advance(DEBOUNCE_MS);
  assert.deepStrictEqual(h.log, []);
  await h.clock.advance(IN_FLIGHT_POLL_MS);
  assert.deepStrictEqual(h.log, []);
  await h.clock.advance(IN_FLIGHT_POLL_MS);
  assert.deepStrictEqual(h.log, [
    "repl.notify 1 file changed",
    "runtime.stop",
    "runtime.start",
  ]);
});

test("/reload restarts the runtime now, in flight or not", async () => {
  const h = harness({ inFlight: [1, 1, 1] });
  h.supervisor.replMessage({ type: "reload" });
  await h.clock.advance(0);
  assert.deepStrictEqual(h.log, [
    "repl.notify reload requested",
    "runtime.stop",
    "runtime.start",
  ]);
});

test("/reload takes saves still in the debounce window with it", async () => {
  const h = harness();
  h.supervisor.changed("prototype/src/a.ts");
  await h.clock.advance(100);
  h.supervisor.replMessage({ type: "reload" });
  await h.clock.advance(0);
  assert.deepStrictEqual(h.batches, [["prototype/src/a.ts"]]);
  assert.deepStrictEqual(h.log[0], "repl.notify 1 file changed");
  await h.clock.advance(DEBOUNCE_MS);
  assert.deepStrictEqual(h.log.filter((e) => e === "runtime.start").length, 1);
});

test("a REPL change rebuilds, then re-execs the REPL in its session", async () => {
  const h = harness({ classify: (p) => ({ runtime: false, repl: true, files: p.length }) });
  h.supervisor.replMessage({ type: "session", id: "01HZZZZZZZZZZZZZZZZZZZZZZZ" });
  h.supervisor.changed("core/dyfj-repl/src/link.rs");
  await h.clock.advance(DEBOUNCE_MS);
  assert.deepStrictEqual(h.log, [
    "build",
    "repl.exit",
    "repl.launch 01HZZZZZZZZZZZZZZZZZZZZZZZ",
  ]);
  assert.match(h.lines.join("\n"), /REPL rebuilt \(1 file changed\)/);
});

test("a wire change restarts the runtime first, then the REPL", async () => {
  const h = harness({ classify: (p) => ({ runtime: true, repl: true, files: p.length }) });
  h.supervisor.changed("prototype/src/contract/turn.ts");
  await h.clock.advance(DEBOUNCE_MS);
  assert.deepStrictEqual(h.log, [
    "build",
    "repl.notify 1 file changed (replaced)",
    "runtime.stop",
    "runtime.start",
    "repl.exit",
    "repl.launch - [1 file changed]",
  ]);
});

test("a reload of both halves is one notice, shown by the REPL that replaces the old one", async () => {
  const h = harness({ classify: (p) => ({ runtime: true, repl: true, files: p.length }) });
  h.supervisor.replMessage({ type: "session", id: "01HZZZZZZZZZZZZZZZZZZZZZZZ" });
  h.supervisor.changed("prototype/src/contract/turn.ts");
  await h.clock.advance(DEBOUNCE_MS);
  assert.strictEqual(h.log.at(-1), "repl.launch 01HZZZZZZZZZZZZZZZZZZZZZZZ [1 file changed]");
  assert.ok(
    h.log.includes("repl.notify 1 file changed (replaced)"),
    "the REPL being replaced is told, so it does not announce the reload as well",
  );
  assert.deepStrictEqual(h.lines, [], "the new REPL says it; the supervisor adds no second line");
});

test("a runtime-only reload does not mark the REPL as replaced", async () => {
  const h = harness({ classify: (p) => ({ runtime: true, repl: false, files: p.length }) });
  h.supervisor.changed("prototype/src/contract/turn.ts");
  await h.clock.advance(DEBOUNCE_MS);
  assert.ok(h.log.includes("repl.notify 1 file changed"));
  assert.ok(!h.log.some((entry) => entry.includes("(replaced)")));
});

test("a REPL-only change launches the REPL with no reload notice of its own", async () => {
  const h = harness({ classify: (p) => ({ runtime: false, repl: true, files: p.length }) });
  h.supervisor.changed("core/dyfj-repl/src/link.rs");
  await h.clock.advance(DEBOUNCE_MS);
  assert.strictEqual(h.log.at(-1), "repl.launch -");
});

test("a build failure keeps the REPL and the runtime, and says why on one line", async () => {
  const h = harness({
    classify: (p) => ({ runtime: p.some((x) => x.endsWith(".ts")), repl: true, files: p.length }),
    build: { ok: false, error: "error[E0425]: cannot find value `x`\n  --> src/link.rs:3:5" },
  });
  h.supervisor.changed("core/dyfj-repl/src/link.rs");
  await h.clock.advance(DEBOUNCE_MS);
  assert.deepStrictEqual(h.log, ["build"]);
  assert.deepStrictEqual(h.lines.length, 1);
  assert.match(h.lines[0]!, /REPL build failed: error\[E0425\]: cannot find value `x`$/);
  assert.doesNotMatch(h.lines[0]!, /\n/);

  h.setBuild({ ok: true });
  h.supervisor.changed("core/dyfj-repl/src/link.rs");
  await h.clock.advance(DEBOUNCE_MS);
  assert.deepStrictEqual(h.log, ["build", "build", "repl.exit", "repl.launch -"]);
});

test("a boot crash leaves the REPL waiting; the next save starts the runtime again", async () => {
  const h = harness({
    classify: (p) => ({ runtime: !p.some((x) => x.endsWith(".test.ts")), repl: false, files: p.length }),
    boot: ["SyntaxError: Unexpected token"],
  });
  h.supervisor.changed("prototype/src/a.ts");
  await h.clock.advance(DEBOUNCE_MS);
  assert.deepStrictEqual(h.log, ["repl.notify 1 file changed", "runtime.stop", "runtime.start"]);
  assert.match(h.lines.at(-1)!, /runtime failed to start: SyntaxError: Unexpected token/);

  // The runtime is down, so a save of anything retries it, and nothing in
  // flight is asked about a runtime that is not there. The reason counts
  // every file since the last reload that took.
  h.supervisor.changed("prototype/src/a.test.ts");
  await h.clock.advance(DEBOUNCE_MS);
  assert.deepStrictEqual(h.log.slice(3), ["repl.notify 2 files changed", "runtime.start"]);
});

test("a boot crash on a wire change keeps the REPL until the runtime is back", async () => {
  const h = harness({
    classify: (p) => ({ runtime: true, repl: true, files: p.length }),
    boot: ["boom"],
  });
  h.supervisor.changed("prototype/src/contract/turn.ts");
  await h.clock.advance(DEBOUNCE_MS);
  assert.deepStrictEqual(h.log.includes("repl.exit"), false);
  h.supervisor.changed("prototype/src/contract/turn.ts");
  await h.clock.advance(DEBOUNCE_MS);
  assert.deepStrictEqual(h.log.slice(-2), ["repl.exit", "repl.launch - [1 file changed]"]);
});

test("a runtime that exits on its own is started again by the next save", async () => {
  const h = harness();
  h.supervisor.runtimeExited(1);
  assert.match(h.lines.at(-1)!, /runtime exited/);
  h.supervisor.changed("prototype/src/cli/render.ts");
  await h.clock.advance(DEBOUNCE_MS);
  assert.deepStrictEqual(h.log, ["repl.notify 1 file changed", "runtime.start"]);
});

test("quitting the REPL stops the runtime and ends the supervisor with its code", async () => {
  const h = harness();
  h.supervisor.changed("prototype/src/a.ts");
  h.supervisor.replExited(3);
  assert.deepStrictEqual(await h.supervisor.done, 3);
  assert.deepStrictEqual(h.log, ["runtime.stop"]);
  await h.clock.advance(DEBOUNCE_MS);
  assert.deepStrictEqual(h.log, ["runtime.stop"]);
});

test("the REPL exit a re-exec asks for does not end the supervisor", async () => {
  const h = harness({ classify: (p) => ({ runtime: false, repl: true, files: p.length }) });
  h.supervisor.changed("core/dyfj-repl/src/link.rs");
  await h.clock.advance(DEBOUNCE_MS);
  let ended = false;
  void h.supervisor.done.then(() => (ended = true));
  await settle();
  assert.deepStrictEqual(ended, false);
});

test("a shutdown signal stops the REPL and the runtime", async () => {
  const h = harness();
  h.supervisor.shutdown();
  assert.deepStrictEqual(await h.supervisor.done, 0);
  assert.deepStrictEqual(h.log, ["repl.exit", "runtime.stop"]);
});

// ─── the last good code ──────────────────────────────────────────────────────

const GOOD: SnapshotCheck = {
  ok: true,
  meta: { contentHash: "sha256:good", takenAt: "2026-10-17T20:15:00.000Z", lockHash: "sha256:lock" },
};

test("a runtime that boots on the working tree is promoted to the last good code", async () => {
  const h = harness();
  h.supervisor.changed("prototype/src/a.ts");
  await h.clock.advance(DEBOUNCE_MS);
  assert.deepStrictEqual(h.promotions, ["sha256:tree"]);
});

test("a failed boot falls back to the last good code, and the session resumes on it", async () => {
  const h = harness({ boot: ["ready", "SyntaxError: Expression expected"], snapshot: [GOOD] });
  // The run's first boot made the snapshot.
  assert.strictEqual(await h.supervisor.boot(), true);
  h.log.length = 0;
  h.promotions.length = 0;
  h.supervisor.replMessage({ type: "session", id: "01TEST00000000000000000001" });
  h.supervisor.changed("prototype/src/engine/agent-loop.ts");
  await h.clock.advance(DEBOUNCE_MS);
  assert.deepStrictEqual(h.log, [
    "repl.notify 1 file changed",
    "runtime.stop",
    "runtime.start",
    "repl.notify running the last good code",
    "runtime.startLastGood",
  ]);
  // The REPL is not restarted: it reconnects to the fallback and resumes.
  assert.ok(!h.log.some((entry) => entry.startsWith("repl.launch") || entry === "repl.exit"));
  assert.deepStrictEqual(h.blocks, ["log: SyntaxError: Expression expected"]);
  assert.match(
    h.lines.at(-1)!,
    /^the working tree's runtime failed to start; running the last good code \(.+\)\. Fix and save to retry\.$/,
  );
  assert.ok(!h.lines.at(-1)!.includes("earlier run"));
  assert.deepStrictEqual(h.promotions, []);
});

test("in fallback, the next save tries the working tree and a good boot promotes it", async () => {
  const h = harness({ boot: ["boom"], snapshot: [GOOD] });
  h.supervisor.changed("prototype/src/a.ts");
  await h.clock.advance(DEBOUNCE_MS);
  // Any save retries the working tree, even one that would not restart it.
  h.supervisor.changed("prototype/src/a.test.ts");
  await h.clock.advance(DEBOUNCE_MS);
  assert.deepStrictEqual(h.log.slice(5), [
    "repl.notify 2 files changed",
    "runtime.stop",
    "runtime.start",
  ]);
  assert.deepStrictEqual(h.promotions, ["sha256:tree"]);
});

test("in fallback, a save waits for the fallback's turn to finish", async () => {
  const h = harness({ boot: ["boom"], snapshot: [GOOD], inFlight: [0, 1] });
  h.supervisor.changed("prototype/src/a.ts");
  await h.clock.advance(DEBOUNCE_MS);
  h.supervisor.changed("prototype/src/a.ts");
  await h.clock.advance(DEBOUNCE_MS);
  assert.strictEqual(h.log.length, 5);
  await h.clock.advance(IN_FLIGHT_POLL_MS);
  assert.deepStrictEqual(h.log.slice(5), ["repl.notify 1 file changed", "runtime.stop", "runtime.start"]);
});

test("with no last good code, a failed boot waits for a save as before", async () => {
  const h = harness({ boot: ["boom"] });
  h.supervisor.changed("prototype/src/a.ts");
  await h.clock.advance(DEBOUNCE_MS);
  assert.ok(!h.log.includes("runtime.startLastGood"));
  assert.match(h.lines.at(-1)!, /^runtime failed to start: boom; save a file to try again$/);
});

test("a changed lock file refuses the fallback with one line", async () => {
  const h = harness({ boot: ["boom"], snapshot: [{ ok: false, reason: "lock" }] });
  h.supervisor.changed("prototype/src/a.ts");
  await h.clock.advance(DEBOUNCE_MS);
  assert.ok(!h.log.includes("runtime.startLastGood"));
  assert.match(h.lines.at(-1)!, /package-lock\.json changed since the last good code.*will not run it\. Fix and save to retry\.$/);
});

test("a last good copy that fails its check is never run", async () => {
  const h = harness({ boot: ["boom"], snapshot: [{ ok: false, reason: "corrupt" }] });
  h.supervisor.changed("prototype/src/a.ts");
  await h.clock.advance(DEBOUNCE_MS);
  assert.ok(!h.log.includes("runtime.startLastGood"));
  assert.match(h.lines.at(-1)!, /no longer matches its record/);
});

test("/rollback switches to the last good code; /reload returns to the working tree", async () => {
  const h = harness({ snapshot: [GOOD] });
  h.supervisor.replMessage({ type: "rollback" });
  await settle();
  assert.deepStrictEqual(h.log, [
    "repl.notify rollback requested",
    "runtime.stop",
    "runtime.startLastGood",
  ]);
  assert.match(h.blocks[0]!, /\/rollback/);
  assert.match(h.lines.at(-1)!, /^running the last good code \(.+\); save or \/reload to return to the working tree$/);
  h.supervisor.replMessage({ type: "reload" });
  await settle();
  assert.deepStrictEqual(h.log.slice(3), ["repl.notify reload requested", "runtime.stop", "runtime.start"]);
  assert.deepStrictEqual(h.promotions, ["sha256:tree"]);
});

test("/rollback with no last good code changes nothing", async () => {
  const h = harness();
  h.supervisor.replMessage({ type: "rollback" });
  await settle();
  assert.deepStrictEqual(h.log, []);
  assert.match(h.lines.at(-1)!, /^no last good code to roll back to/);
});

test("the first boot falls back to last good code from an earlier run, and says so", async () => {
  const h = harness({ boot: ["boom"], snapshot: [GOOD] });
  assert.strictEqual(await h.supervisor.boot(), true);
  assert.deepStrictEqual(h.log, ["runtime.start", "runtime.startLastGood"]);
  assert.match(
    h.lines.at(-1)!,
    /^the working tree's runtime failed to start; running the last good code from an earlier run \(.+\)\. Fix and save to retry\.$/,
  );
});

test("the first boot with no last good code fails, as before", async () => {
  const h = harness({ boot: ["boom"] });
  assert.strictEqual(await h.supervisor.boot(), false);
  assert.deepStrictEqual(h.log, ["runtime.start"]);
  assert.match(h.lines.at(-1)!, /^the runtime did not start: boom$/);
});

test("a first boot that starts is promoted", async () => {
  const h = harness();
  assert.strictEqual(await h.supervisor.boot(), true);
  assert.deepStrictEqual(h.promotions, ["sha256:tree"]);
});

test("/rollback keeps a REPL rebuild that was already queued", async () => {
  const h = harness({
    snapshot: [GOOD],
    classify: (p) => ({ runtime: false, repl: true, files: p.length }),
  });
  h.supervisor.changed("core/dyfj-repl/src/link.rs");
  h.supervisor.replMessage({ type: "rollback" });
  await settle();
  assert.deepStrictEqual(h.log, [
    "repl.notify rollback requested",
    "runtime.stop",
    "runtime.startLastGood",
    "build",
    "repl.exit",
    "repl.launch -",
  ]);
});
