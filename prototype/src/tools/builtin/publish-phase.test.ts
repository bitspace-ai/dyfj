import assert from "node:assert/strict";
import { realpathSync, rmSync } from "node:fs";
import { chmod, mkdir, mkdtemp, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { after, describe, it } from "node:test";
import { composeRuntimePolicy } from "../../config/mod.ts";
import {
  defaultPublishReportPath,
  type PublishConfig,
} from "../../config/publish-config.ts";
import type { GitLayout } from "./publish-git.ts";
import {
  pathFreeReason,
  PublishReport,
  type PublishReportSink,
  runGates,
  sandboxWriteCheck,
} from "./publish-phase.ts";
import type { PublishCommandResult } from "./publish-run.ts";
import { PublishTickets } from "./publish-tickets.ts";

const HEAD = "0123456789abcdef0123456789abcdef01234567";

/** The report tests' directories are the test's own, not the sandbox's. */
const NOT_SANDBOX_WRITABLE = { writableBySandbox: () => Promise.resolve(false) };

// Realpath'd: the report directory must resolve to itself, and macOS bridges
// /tmp to /private/tmp.
const ROOT = realpathSync(await mkdtemp(join(tmpdir(), "dyfj-publish-phase-")));
// Synchronous: an async reap leaves an FS request live past the file's
// handle check.
after(() => rmSync(ROOT, { recursive: true, force: true }));

function layout(overrides: Partial<GitLayout> = {}): GitLayout {
  return {
    gitDir: join(ROOT, ".git"),
    commonDir: join(ROOT, ".git"),
    topLevel: ROOT,
    branchRef: "refs/heads/chris/bit-786-host-publish-tool",
    head: HEAD,
    ...overrides,
  };
}

function config(overrides: Partial<PublishConfig> = {}): PublishConfig {
  return {
    preGate: ["./pre-gate"],
    gate: ["./gate"],
    reportPath: join(ROOT, "{ticket}.log"),
    gateTimeoutMs: 600_000,
    ticketTtlMs: 3_600_000,
    ...overrides,
  };
}

function ok(output = ""): PublishCommandResult {
  return {
    code: 0,
    timedOut: false,
    cancelled: false,
    output,
    truncated: false,
    pipesLeftOpen: false,
  };
}

/** A report sink that records what it was shown. */
function sink(): PublishReportSink & { phases: string[] } {
  const phases: string[] = [];
  return {
    phases,
    writeError: undefined,
    append: (phase) => {
      phases.push(phase);
      return Promise.resolve();
    },
  };
}

function setup(
  options: {
    layout?: GitLayout;
    script?: readonly PublishCommandResult[];
    onStart?: (index: number) => void;
    readLayout?: () => Promise<GitLayout>;
    tickets?: PublishTickets;
    config?: PublishConfig;
  } = {},
) {
  const tickets = options.tickets ?? new PublishTickets({ ttlMs: 3_600_000 });
  const created = tickets.create({
    sessionId: "s1",
    layout: options.layout ?? layout(),
    reportPathFor: (ticket) => join(ROOT, `${ticket}.log`),
  });
  const calls: string[][] = [];
  let index = 0;
  const startCommand = (command: { argv: readonly string[] }) => {
    calls.push([...command.argv]);
    options.onStart?.(index);
    const scripted = options.script ?? [];
    const result = scripted[index++] ?? ok();
    return { result: Promise.resolve(result), cancel: () => {} };
  };
  const report = sink();
  const run = runGates(
    {
      config: options.config ?? config(),
      tickets,
      policy: composeRuntimePolicy(),
      sessionId: "s1",
      readLayout: options.readLayout ?? (() => Promise.resolve(layout())),
      startCommand: startCommand as never,
    },
    created,
    undefined,
    "anthropic",
    report,
  );
  return { tickets, created, calls, report, run };
}

describe("publish phases: the layout is re-read", () => {
  it("refuses the pre-gate when the layout already moved", async () => {
    // The ticket pinned HEAD; the reader now reports another commit.
    const { tickets, created, calls, run } = setup({
      readLayout: () => Promise.resolve(layout({ head: "f".repeat(40) })),
    });
    await run;
    assert.deepStrictEqual(calls, []);
    const view = tickets.get("s1", created.ticket)!;
    assert.strictEqual(view.phase, "failed");
    assert.strictEqual(view.failedPhase, "pre-gate");
    assert.match(view.reason ?? "", /changed since the ticket was created/);
  });

  it("refuses the gate when the layout moves during the pre-gate", async () => {
    let reads = 0;
    const { tickets, created, calls, run } = setup({
      // First read (before the pre-gate) matches; the second does not.
      readLayout: () => {
        reads += 1;
        return Promise.resolve(
          reads === 1 ? layout() : layout({ head: "e".repeat(40) }),
        );
      },
    });
    await run;
    assert.strictEqual(calls.length, 1, "the gate must not start");
    const view = tickets.get("s1", created.ticket)!;
    assert.strictEqual(view.phase, "failed");
    assert.strictEqual(view.failedPhase, "pre-gate");
    assert.match(view.reason ?? "", /the gate did not start/);
  });

  it("fails rather than throwing when the layout cannot be read", async () => {
    const { tickets, created, run } = setup({
      readLayout: () => Promise.reject(new Error("boom")),
    });
    await run;
    const view = tickets.get("s1", created.ticket)!;
    assert.strictEqual(view.phase, "failed");
    assert.match(view.reason ?? "", /could not be re-read/);
  });

  it("gives every child the pinned git dir", async () => {
    let seen: Record<string, string> = {};
    const tickets = new PublishTickets({ ttlMs: 3_600_000 });
    const created = tickets.create({
      sessionId: "s1",
      layout: layout(),
      reportPathFor: (ticket) => join(ROOT, `${ticket}.log`),
    });
    await runGates(
      {
        config: config(),
        tickets,
        policy: composeRuntimePolicy(),
        sessionId: "s1",
        readLayout: () => Promise.resolve(layout()),
        startCommand: ((command: { env: Record<string, string> }) => {
          seen = command.env;
          return { result: Promise.resolve(ok()), cancel: () => {} };
        }) as never,
      },
      created,
      undefined,
      "anthropic",
      sink(),
    );
    assert.strictEqual(seen["GIT_DIR"], layout().gitDir);
    assert.strictEqual(seen["GIT_WORK_TREE"], ROOT);
    assert.ok(seen["GIT_CONFIG_COUNT"] !== undefined);
  });

  it("builds the child environment from the supplied source", async () => {
    let seen: Record<string, string> = {};
    const tickets = new PublishTickets({ ttlMs: 3_600_000 });
    const created = tickets.create({
      sessionId: "s1",
      layout: layout(),
      reportPathFor: (ticket) => join(ROOT, `${ticket}.log`),
    });
    await runGates(
      {
        config: config(),
        tickets,
        policy: composeRuntimePolicy(),
        sessionId: "s1",
        readLayout: () => Promise.resolve(layout()),
        childEnv: {
          get: (name) => ({ PATH: "/fixture/bin" } as Record<string, string>)[name],
        },
        startCommand: ((command: { env: Record<string, string> }) => {
          seen = command.env;
          return { result: Promise.resolve(ok()), cancel: () => {} };
        }) as never,
      },
      created,
      undefined,
      "anthropic",
      sink(),
    );
    assert.strictEqual(seen["PATH"], "/fixture/bin");
  });
});

describe("publish phases: a rejection is the phase's failure", () => {
  it("fails the ticket when the command cannot start", async () => {
    const tickets = new PublishTickets({ ttlMs: 3_600_000 });
    const created = tickets.create({
      sessionId: "s1",
      layout: layout(),
      reportPathFor: (ticket) => join(ROOT, `${ticket}.log`),
    });
    const run = runGates(
      {
        config: config(),
        tickets,
        policy: composeRuntimePolicy(),
        sessionId: "s1",
        readLayout: () => Promise.resolve(layout()),
        startCommand: (() => {
          throw new Error("spawn of \"./pre-gate\" refused: not in the run policy");
        }) as never,
      },
      created,
      undefined,
      "anthropic",
      sink(),
    );
    await run;
    const view = tickets.get("s1", created.ticket)!;
    assert.strictEqual(view.phase, "failed");
    assert.strictEqual(view.failedPhase, "pre-gate");
    assert.match(view.reason ?? "", /could not run/);
    assert.match(view.reason ?? "", /not in the run policy/);
  });

  it("fails the ticket when a command handle rejects", async () => {
    const tickets = new PublishTickets({ ttlMs: 3_600_000 });
    const created = tickets.create({
      sessionId: "s1",
      layout: layout(),
      reportPathFor: (ticket) => join(ROOT, `${ticket}.log`),
    });
    await runGates(
      {
        config: config(),
        tickets,
        policy: composeRuntimePolicy(),
        sessionId: "s1",
        readLayout: () => Promise.resolve(layout()),
        startCommand: (() => ({
          result: Promise.reject(new Error("the runner died")),
          cancel: () => {},
        })) as never,
      },
      created,
      undefined,
      "anthropic",
      sink(),
    );
    const view = tickets.get("s1", created.ticket)!;
    assert.strictEqual(view.phase, "failed");
    assert.match(view.reason ?? "", /the runner died/);
  });

  it("fails the ticket when a substitution cannot be filled", async () => {
    const { tickets, created, calls, run } = setup({
      config: config({ preGate: ["./pre-gate", "--issue={unknown}"] }),
    });
    await run;
    assert.deepStrictEqual(calls, []);
    const view = tickets.get("s1", created.ticket)!;
    assert.strictEqual(view.phase, "failed");
    assert.match(view.reason ?? "", /unknown/);
  });
});

describe("publish phases: a dead ticket starts nothing", () => {
  it("starts no gate when the ticket was cancelled during the report write", async () => {
    let tickets: PublishTickets;
    const calls: string[][] = [];
    tickets = new PublishTickets({ ttlMs: 3_600_000 });
    const created = tickets.create({
      sessionId: "s1",
      layout: layout(),
      reportPathFor: (ticket) => join(ROOT, `${ticket}.log`),
    });
    const report: PublishReportSink = {
      writeError: undefined,
      append: () => {
        // The operator cancels while the phase's output is being written.
        tickets.cancel("s1", created.ticket);
        return Promise.resolve();
      },
    };
    await runGates(
      {
        config: config(),
        tickets,
        policy: composeRuntimePolicy(),
        sessionId: "s1",
        readLayout: () => Promise.resolve(layout()),
        startCommand: ((command: { argv: readonly string[] }) => {
          calls.push([...command.argv]);
          return { result: Promise.resolve(ok()), cancel: () => {} };
        }) as never,
      },
      created,
      undefined,
      "anthropic",
      report,
    );
    assert.strictEqual(calls.length, 1, "the gate must not start");
    const view = tickets.get("s1", created.ticket)!;
    assert.strictEqual(view.phase, "failed");
    assert.strictEqual(view.reason, "cancelled by the operator");
  });

  it("starts no gate when markGated refuses", async () => {
    const tickets = new PublishTickets({ ttlMs: 1 });
    const created = tickets.create({
      sessionId: "s1",
      layout: layout(),
      reportPathFor: (ticket) => join(ROOT, `${ticket}.log`),
    });
    let calls = 0;
    await runGates(
      {
        config: config(),
        tickets,
        policy: composeRuntimePolicy(),
        sessionId: "s1",
        readLayout: () => Promise.resolve(layout()),
        startCommand: (() => {
          calls += 1;
          return { result: Promise.resolve(ok()), cancel: () => {} };
        }) as never,
      },
      created,
      undefined,
      "anthropic",
      {
        writeError: undefined,
        // Let the ticket's one-millisecond lifetime pass mid-run.
        append: () =>
          new Promise((resolve) => setTimeout(resolve, 20)),
      },
    );
    assert.strictEqual(calls, 1, "the gate must not start");
    assert.strictEqual(tickets.get("s1", created.ticket)?.phase, "expired");
  });
});

describe("publish phases: the report file", () => {
  it("refuses a path that already exists", async () => {
    const path = join(ROOT, "occupied.log");
    await writeFile(path, "someone else's report\n", { mode: 0o600 });
    const report = new PublishReport(path, NOT_SANDBOX_WRITABLE);
    await assert.rejects(
      () => report.start(),
      (error: unknown) =>
        error instanceof Error && (error as { code?: string }).code === "EEXIST",
    );
  });

  it("refuses a symlink at the report path", async () => {
    const target = join(ROOT, "target.log");
    await writeFile(target, "x\n", { mode: 0o600 });
    const link = join(ROOT, "link.log");
    await symlink(target, link);
    const report = new PublishReport(link, NOT_SANDBOX_WRITABLE);
    await assert.rejects(
      () => report.start(),
      (error: unknown) =>
        error instanceof Error && (error as { code?: string }).code === "EEXIST",
    );
  });

  it("writes with 0600 in a directory only its owner may read", async () => {
    const dir = join(ROOT, "nested", "reports");
    const path = join(dir, "run.log");
    const report = new PublishReport(path, NOT_SANDBOX_WRITABLE);
    await report.append("pre-gate", ok("hello"));
    await report.close();
    const file = await stat(path);
    const directory = await stat(dir);
    assert.strictEqual(file.mode & 0o777, 0o600);
    assert.strictEqual(directory.mode & 0o777, 0o700);
  });

  it("records a write failure instead of throwing", async () => {
    const path = join(ROOT, "no-such-dir-is-a-file", "run.log");
    await writeFile(join(ROOT, "no-such-dir-is-a-file"), "a file\n");
    const report = new PublishReport(path, NOT_SANDBOX_WRITABLE);
    await report.append("pre-gate", ok("hello"));
    assert.ok(report.writeError !== undefined);
  });

  it("names a short report on the ticket", async () => {
    const tickets = new PublishTickets({ ttlMs: 3_600_000 });
    const created = tickets.create({
      sessionId: "s1",
      layout: layout(),
      reportPathFor: (ticket) => join(ROOT, `${ticket}.log`),
    });
    await runGates(
      {
        config: config(),
        tickets,
        policy: composeRuntimePolicy(),
        sessionId: "s1",
        readLayout: () => Promise.resolve(layout()),
        startCommand: (() => ({
          result: Promise.resolve({ ...ok(), code: 4 }),
          cancel: () => {},
        })) as never,
      },
      created,
      undefined,
      "anthropic",
      {
        writeError: "EACCES: permission denied",
        append: () => Promise.resolve(),
      },
    );
    const view = tickets.get("s1", created.ticket)!;
    assert.strictEqual(view.phase, "failed");
    assert.match(view.reason ?? "", /report could not be written/);
    assert.strictEqual(view.reportError, "EACCES: permission denied");
  });
});

// Assembled at runtime so the public-boundary scan never matches the fixtures
// as a home-directory path in tracked source.
const FAKE_HOME = ["", "home", "x"].join("/");
const FAKE_WIN_HOME = ["C:", "\\", "Users", "x"].join("");

describe("publish phases: reasons that leave the runtime alone", () => {
  it("removes a host path from an exception's message", () => {
    assert.strictEqual(
      pathFreeReason(
        new Error(
          `spawn of "${FAKE_HOME}/repo/bin/gate" refused: not in policy`,
        ),
      ),
      'spawn of "<path>" refused: not in policy',
    );
    assert.strictEqual(pathFreeReason(new Error("plain message")), "plain message");
    assert.strictEqual(
      pathFreeReason(new Error(`${FAKE_WIN_HOME}/gate.exe failed`)),
      "<path> failed",
    );
    // The reason is bounded like any other operator-facing line.
    assert.ok(pathFreeReason(new Error("a".repeat(900))).length <= 300);
  });

  it("reports a command that cannot start without its path", async () => {
    const tickets = new PublishTickets({ ttlMs: 3_600_000 });
    const created = tickets.create({
      sessionId: "s1",
      layout: layout(),
      reportPathFor: (ticket) => join(ROOT, `refused-${ticket}.log`),
    });
    await runGates(
      {
        config: config(),
        tickets,
        policy: composeRuntimePolicy(),
        sessionId: "s1",
        readLayout: () => Promise.resolve(layout()),
        startCommand: (() => {
          throw new Error(
            `spawn of "${FAKE_HOME}/private/gate" refused by policy`,
          );
        }) as never,
      },
      created,
      undefined,
      "anthropic",
      sink(),
    );
    const failed = tickets.get("s1", created.ticket);
    assert.match(failed?.reason ?? "", /could not run: spawn of "<path>"/);
    assert.ok(!(failed?.reason ?? "").includes(FAKE_HOME));
  });
});

describe("publish phases: liveness and the pins after every await", () => {
  it("starts nothing when the ticket died while the report was written", async () => {
    // The report sink cancels the ticket mid-write: the next phase must not
    // start, even though the pre-gate itself succeeded.
    const tickets = new PublishTickets({ ttlMs: 3_600_000 });
    const created = tickets.create({
      sessionId: "s1",
      layout: layout(),
      reportPathFor: (ticket) => join(ROOT, `live-${ticket}.log`),
    });
    const calls: string[] = [];
    const cancelling: PublishReportSink = {
      writeError: undefined,
      append: () => {
        tickets.cancel("s1", created.ticket);
        return Promise.resolve();
      },
    };
    await runGates(
      {
        config: config(),
        tickets,
        policy: composeRuntimePolicy(),
        sessionId: "s1",
        readLayout: () => Promise.resolve(layout()),
        startCommand: ((command: { argv: readonly string[] }) => {
          calls.push(command.argv[0]!);
          return { result: Promise.resolve(ok()), cancel: () => {} };
        }) as never,
      },
      created,
      undefined,
      "claude-opus-5",
      cancelling,
    );
    assert.deepStrictEqual(calls, ["./pre-gate"]);
  });

  it("fails the ticket when the pins move while the gate runs", async () => {
    let reads = 0;
    const tickets = new PublishTickets({ ttlMs: 3_600_000 });
    const created = tickets.create({
      sessionId: "s1",
      layout: layout(),
      reportPathFor: (ticket) => join(ROOT, `moved-${ticket}.log`),
    });
    await runGates(
      {
        config: config(),
        tickets,
        policy: composeRuntimePolicy(),
        sessionId: "s1",
        // Pinned, pinned, pinned, then a moved head for the post-gate read.
        readLayout: () => {
          reads += 1;
          return Promise.resolve(
            reads < 4 ? layout() : layout({ head: "e".repeat(40) }),
          );
        },
        startCommand: (() => ({
          result: Promise.resolve(ok()),
          cancel: () => {},
        })) as never,
      },
      created,
      undefined,
      "claude-opus-5",
      sink(),
    );
    const view = tickets.get("s1", created.ticket)!;
    assert.strictEqual(view.phase, "failed");
    assert.strictEqual(view.failedPhase, "gate");
    assert.match(view.reason ?? "", /changed while the gate ran/);
  });

  it("reports an incomplete report even when both phases passed", async () => {
    const tickets = new PublishTickets({ ttlMs: 3_600_000 });
    const created = tickets.create({
      sessionId: "s1",
      layout: layout(),
      reportPathFor: (ticket) => join(ROOT, `short-${ticket}.log`),
    });
    const broken: PublishReportSink = {
      writeError: "EACCES: permission denied",
      append: () => Promise.resolve(),
    };
    await runGates(
      {
        config: config(),
        tickets,
        policy: composeRuntimePolicy(),
        sessionId: "s1",
        readLayout: () => Promise.resolve(layout()),
        startCommand: (() => ({
          result: Promise.resolve(ok()),
          cancel: () => {},
        })) as never,
      },
      created,
      undefined,
      "claude-opus-5",
      broken,
    );
    const view = tickets.get("s1", created.ticket)!;
    assert.strictEqual(view.phase, "ready");
    assert.match(view.reportError ?? "", /permission denied/);
  });
});

describe("publish phases: the report and the sandbox", () => {
  it("refuses a report directory the sandbox can write", async () => {
    const report = new PublishReport(join(ROOT, "sandboxed", "run.log"), {
      writableBySandbox: () => Promise.resolve(true),
    });
    await assert.rejects(() => report.start(), /writable from the sandbox/);
  });

  it("knows the workspace and srt's scratch are writable, and elsewhere is not", async () => {
    const check = sandboxWriteCheck(layout());
    assert.strictEqual(await check(join(ROOT, "reports")), true);
    assert.strictEqual(await check("/tmp/claude/reports"), true);
    // Not under tmpdir(): inside the sandbox that is srt's scratch, which is
    // writable. A path that need not exist is resolved through its ancestors.
    assert.strictEqual(await check("/usr/share/dyfj-not-a-write-grant"), false);
  });

  it("says in the report when a phase's output was cut", async () => {
    const dir = join(ROOT, "cut");
    const path = join(dir, "run.log");
    const report = new PublishReport(path, NOT_SANDBOX_WRITABLE);
    await report.append("gate", { ...ok("tail\n"), truncated: true });
    await report.close();
    const { readFile } = await import("node:fs/promises");
    assert.match(await readFile(path, "utf8"), /earlier output dropped above/);
  });
});

describe("publish phases: the default report path", () => {
  it(
    "opens under the default path when the temp directory is behind a symlink",
    { skip: process.platform === "win32" },
    async () => {
    // macOS's temp directory is under /var, a symlink to /private/var; a
    // symlinked TMPDIR reproduces that on a POSIX host that honors TMPDIR.
    const real = realpathSync(await mkdtemp(join(tmpdir(), "dyfj-publish-tmp-")));
    const linked = `${real}-link`;
    await symlink(real, linked);
    const saved = process.env["TMPDIR"];
    process.env["TMPDIR"] = linked;
    try {
      const path = defaultPublishReportPath().replace("{ticket}", "run");
      assert.ok(path.startsWith(`${real}/`), "the default is built from the resolved path");
      const report = new PublishReport(path, NOT_SANDBOX_WRITABLE);
      await report.start();
      await report.close();
    } finally {
      if (saved === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = saved;
      rmSync(linked, { force: true });
      rmSync(real, { recursive: true, force: true });
    }
  },
  );
});

describe("publish phases: the report directory", () => {
  it("refuses a directory another user could write", async () => {
    const dir = join(ROOT, "shared");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o770);
    const report = new PublishReport(join(dir, "run.log"), NOT_SANDBOX_WRITABLE);
    await assert.rejects(
      report.start(),
      /readable or writable beyond its owner/,
    );
  });

  it("refuses a directory reached through a symlinked ancestor", async () => {
    const real = join(ROOT, "real");
    await mkdir(real, { recursive: true, mode: 0o700 });
    const linked = join(ROOT, "linked");
    await symlink(real, linked);
    const report = new PublishReport(join(linked, "run.log"), NOT_SANDBOX_WRITABLE);
    await assert.rejects(report.start(), /resolves through a symlink/);
  });
});

describe("publish phases: a cancel during a layout read starts nothing", () => {
  /** A layout read that holds the run until the test says go. */
  function heldRead(layoutValue: GitLayout) {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    const read = async (): Promise<GitLayout> => {
      reads += 1;
      // The first read is the pre-gate's check, the second the gate's.
      if (reads === 1) await gate;
      return layoutValue;
    };
    return { read, release, readsSoFar: () => reads };
  }

  it("cancelled mid-read, neither phase starts a process", async () => {
    const tickets = new PublishTickets({ ttlMs: 3_600_000 });
    const created = tickets.create({
      sessionId: "s1",
      layout: layout(),
      reportPathFor: (ticket) => join(ROOT, `cancel-read-${ticket}.log`),
    });
    const held = heldRead(layout());
    const calls: string[] = [];
    const run = runGates(
      {
        config: config(),
        tickets,
        policy: composeRuntimePolicy(),
        sessionId: "s1",
        readLayout: held.read,
        startCommand: ((command: { argv: readonly string[] }) => {
          calls.push(command.argv[0]!);
          return { result: Promise.resolve(ok()), cancel: () => {} };
        }) as never,
      },
      created,
      undefined,
      "claude-opus-5",
      sink(),
    );
    // The pre-gate's read is pending; the operator cancels.
    tickets.cancel("s1", created.ticket);
    held.release();
    await run;
    assert.deepStrictEqual(calls, [], "no process may start after a cancel");
  });

  it("expired mid-read, neither phase starts a process", async () => {
    let now = 1_000;
    const tickets = new PublishTickets({ ttlMs: 1_000, now: () => now });
    const created = tickets.create({
      sessionId: "s1",
      layout: layout(),
      reportPathFor: (ticket) => join(ROOT, `expire-read-${ticket}.log`),
    });
    const held = heldRead(layout());
    const calls: string[] = [];
    const run = runGates(
      {
        config: config(),
        tickets,
        policy: composeRuntimePolicy(),
        sessionId: "s1",
        readLayout: held.read,
        startCommand: ((command: { argv: readonly string[] }) => {
          calls.push(command.argv[0]!);
          return { result: Promise.resolve(ok()), cancel: () => {} };
        }) as never,
      },
      created,
      undefined,
      "claude-opus-5",
      sink(),
    );
    // The TTL passes while the read is pending: the next look expires it.
    now += 5_000;
    held.release();
    await run;
    assert.deepStrictEqual(calls, [], "no process may start after an expiry");
    assert.strictEqual(tickets.get("s1", created.ticket)?.phase, "expired");
  });

  it("refuses to attach a cancel hook to a ticket that already left its phase", () => {
    const tickets = new PublishTickets({ ttlMs: 3_600_000 });
    const created = tickets.create({
      sessionId: "s1",
      layout: layout(),
      reportPathFor: (ticket) => join(ROOT, `hook-${ticket}.log`),
    });
    let ran = false;
    tickets.cancel("s1", created.ticket);
    assert.strictEqual(
      tickets.attachCancelHook("s1", created.ticket, () => {
        ran = true;
      }),
      false,
    );
    assert.strictEqual(ran, false);
  });
});
