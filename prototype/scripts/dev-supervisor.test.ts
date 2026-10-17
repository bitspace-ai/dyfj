import assert from "node:assert/strict";
import { test } from "node:test";
import type { BatchClass } from "./dev-classify.ts";
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
} = {}) {
  const clock = new FakeClock();
  const log: string[] = [];
  const lines: string[] = [];
  const batches: string[][] = [];
  const inFlight = [...(options.inFlight ?? [])];
  const boots = [...(options.boot ?? [])];
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
        return next === "ready" ? { ok: true } : { ok: false, error: next };
      },
      stop: async () => {
        log.push("runtime.stop");
      },
      inFlightTurns: async () => inFlight.length > 0 ? inFlight.shift()! : 0,
    },
    repl: {
      launch: (session) => {
        log.push(`repl.launch ${session ?? "-"}`);
      },
      exit: async () => {
        log.push("repl.exit");
      },
      notify: (message) => {
        log.push(`repl.notify ${message.reason}`);
      },
    },
    build: async () => {
      log.push("build");
      return build;
    },
    report: (line) => lines.push(line),
  };
  const supervisor = new DevSupervisor(ports);
  return {
    clock,
    log,
    lines,
    batches,
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
    "repl.notify 1 file changed",
    "runtime.stop",
    "runtime.start",
    "repl.exit",
    "repl.launch -",
  ]);
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
  assert.deepStrictEqual(h.log.slice(-2), ["repl.exit", "repl.launch -"]);
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
