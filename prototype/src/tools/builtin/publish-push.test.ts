import assert from "node:assert/strict";
import { realpathSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { composeRuntimePolicy } from "../../config/mod.ts";
import type { PublishConfig } from "../../config/publish-config.ts";
import { CommandExecutionError } from "../definition.ts";
import type { GitLayout } from "./publish-git.ts";
import { runPush } from "./publish-push.ts";
import type { PublishCommandResult } from "./publish-run.ts";
import { PublishTickets } from "./publish-tickets.ts";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const PR_URL = "https://github.com/example/repo/pull/7";

// Assembled at runtime so the public-boundary scan never matches a fixture as
// a home-directory path in tracked source.
const FAKE_HOME = ["", "home", "x"].join("/");

// Realpath'd for parity with the phase fixtures: nothing here opens a file,
// but the layout's root is a real directory either way.
const ROOT = realpathSync(await mkdtemp(join(tmpdir(), "dyfj-publish-push-")));
after(() => rmSync(ROOT, { recursive: true, force: true }));

function layout(overrides: Partial<GitLayout> = {}): GitLayout {
  return {
    gitDir: join(ROOT, ".git"),
    commonDir: join(ROOT, ".git"),
    topLevel: ROOT,
    branchRef: "refs/heads/chris/bit-830-publish-push-runner",
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
    push: ["git", "push", "origin", "{head}:refs/heads/{branch}"],
    openPr: ["gh", "pr", "create", "--head={branch}"],
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

/** A ticket already past both gates. */
function gated(tickets: PublishTickets, sessionId = "s1") {
  const view = tickets.create({
    sessionId,
    layout: layout(),
    reportPathFor: (ticket) => join(ROOT, `${ticket}.log`),
  });
  tickets.markGated(sessionId, view.ticket);
  tickets.markReady(sessionId, view.ticket);
  return view;
}

function setup(
  options: {
    phase?: "ready" | "pushed" | "gated" | "failed";
    script?: readonly (PublishCommandResult | Error)[];
    readLayout?: () => Promise<GitLayout>;
    config?: PublishConfig;
    now?: () => number;
    ttlMs?: number;
  } = {},
) {
  const tickets = new PublishTickets({
    ttlMs: options.ttlMs ?? 3_600_000,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const created = gated(tickets);
  const phase = options.phase ?? "ready";
  if (phase === "pushed") {
    tickets.markPushing("s1", created.ticket, HEAD);
    tickets.markPushed("s1", created.ticket);
  } else if (phase === "failed") {
    tickets.markFailed("s1", created.ticket, "gate", "the gate exited 1", "", false);
  }
  // `gated` is reached by undoing readiness: a fresh ticket one phase back.
  const target = phase === "gated" || phase === "failed"
    ? (() => {
      const back = tickets.create({
        sessionId: "s1",
        layout: layout(),
        reportPathFor: (ticket) => join(ROOT, `${ticket}.log`),
      });
      if (phase === "gated") {
        tickets.markGated("s1", back.ticket);
      } else {
        tickets.markFailed(
          "s1",
          back.ticket,
          "gate",
          "the gate exited 1",
          "",
          false,
        );
      }
      return back;
    })()
    : created;

  const calls: string[][] = [];
  let index = 0;
  const startCommand = (command: { argv: readonly string[] }) => {
    calls.push([...command.argv]);
    const scripted = options.script?.[index++] ?? ok();
    if (scripted instanceof Error) {
      return {
        result: Promise.reject(scripted),
        cancel: () => {},
      };
    }
    return { result: Promise.resolve(scripted), cancel: () => {} };
  };
  const run = runPush(
    {
      config: options.config ?? config(),
      tickets,
      policy: composeRuntimePolicy(),
      sessionId: "s1",
      readLayout: options.readLayout ?? (() => Promise.resolve(layout())),
      startCommand: startCommand as never,
    },
    target.ticket,
  );
  return { tickets, created: target, calls, run };
}

describe("publish push: a ready ticket ships", () => {
  it("runs the push, then open_pr, and carries the URL", async () => {
    const { tickets, created, calls, run } = setup({
      script: [ok(), ok(`${PR_URL}\n`)],
    });
    const view = await run;
    assert.deepStrictEqual(calls, [
      ["git", "push", "origin", `${HEAD}:refs/heads/chris/bit-830-publish-push-runner`],
      ["gh", "pr", "create", "--head=chris/bit-830-publish-push-runner"],
    ]);
    assert.strictEqual(view.phase, "pr-open");
    assert.strictEqual(view.prUrl, PR_URL);
    assert.strictEqual(view.reason, undefined);
    assert.strictEqual(tickets.get("s1", created.ticket)?.phase, "pr-open");
  });

  it("gives both children the pinned git dir, as the gates do", async () => {
    const envs: Record<string, string>[] = [];
    const tickets = new PublishTickets({ ttlMs: 3_600_000 });
    const created = gated(tickets);
    await runPush(
      {
        config: config(),
        tickets,
        policy: composeRuntimePolicy(),
        sessionId: "s1",
        readLayout: () => Promise.resolve(layout()),
        startCommand: ((command: { env: Record<string, string> }) => {
          envs.push(command.env);
          return {
            result: Promise.resolve(ok(envs.length === 1 ? "" : PR_URL)),
            cancel: () => {},
          };
        }) as never,
      },
      created.ticket,
    );
    assert.strictEqual(envs.length, 2);
    for (const env of envs) {
      assert.strictEqual(env["GIT_DIR"], layout().gitDir);
      assert.strictEqual(env["GIT_WORK_TREE"], ROOT);
      assert.ok(env["GIT_CONFIG_COUNT"] !== undefined);
    }
  });

  it("takes the last URL-shaped line, and only a URL-shaped one", async () => {
    const { run } = setup({
      script: [
        ok(),
        ok(`Creating pull request\n${PR_URL}\n8 comments mention https://x.test/a\n`),
      ],
    });
    const view = await run;
    assert.strictEqual(view.phase, "pr-open");
    assert.strictEqual(view.prUrl, PR_URL);
  });

  it("pushes the commit the pins still name, and starts nothing else", async () => {
    const { calls, run } = setup({ script: [ok(), ok(PR_URL)] });
    await run;
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0]?.[0], "git");
  });
});

describe("publish push: a failed push is final", () => {
  it("ends in failed with the push as its phase, and never opens a PR", async () => {
    const { tickets, created, calls, run } = setup({
      script: [{ ...ok("! [rejected] main -> main\n"), code: 128 }],
    });
    const view = await run;
    assert.strictEqual(calls.length, 1, "open_pr must not start");
    assert.strictEqual(view.phase, "failed");
    assert.strictEqual(view.failedPhase, "push");
    assert.strictEqual(view.reason, "the push exited 128");
    assert.match(view.outputHead ?? "", /rejected/);
    assert.strictEqual(tickets.get("s1", created.ticket)?.phase, "failed");
  });

  it("records a timeout and a cancel as the push's failure", async () => {
    for (
      const result of [
        { ...ok("still going"), timedOut: true, code: null },
        { ...ok("stopped"), cancelled: true, code: null },
      ]
    ) {
      const { calls, run } = setup({ script: [result] });
      const view = await run;
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(view.phase, "failed");
      assert.strictEqual(view.failedPhase, "push");
      assert.match(view.reason ?? "", /push/);
    }
  });

  it("records a command that cannot start as the push's failure", async () => {
    const { calls, run } = setup({
      script: [
        new Error(`spawn of "${FAKE_HOME}/bin/git" refused by policy`),
      ],
    });
    const view = await run;
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(view.phase, "failed");
    assert.strictEqual(view.failedPhase, "push");
    assert.match(view.reason ?? "", /could not run/);
    assert.match(view.reason ?? "", /<path>/);
    assert.ok(!(view.reason ?? "").includes(FAKE_HOME));
  });

  it("leaves a refused ticket alone when its head moved", async () => {
    const { tickets, created, calls, run } = setup({
      readLayout: () => Promise.resolve(layout({ head: "f".repeat(40) })),
    });
    await assert.rejects(
      () => run,
      (error: unknown) => {
        assert.ok(error instanceof CommandExecutionError);
        assert.match(error.message, /changed since the ticket was created/);
        assert.ok(!error.message.includes(ROOT));
        return true;
      },
    );
    assert.deepStrictEqual(calls, [], "no command starts");
    assert.strictEqual(tickets.get("s1", created.ticket)?.phase, "ready");
  });

  it("throws rather than pushing when the layout cannot be read", async () => {
    const { tickets, created, calls, run } = setup({
      readLayout: () => Promise.reject(new Error("boom")),
    });
    await assert.rejects(() => run, /could not be re-read/);
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(tickets.get("s1", created.ticket)?.phase, "ready");
  });
});

describe("publish push: a failed pull request is retryable", () => {
  it("leaves the ticket pushed, with a reason, and a retry runs only open_pr", async () => {
    const tickets = new PublishTickets({ ttlMs: 3_600_000 });
    const created = gated(tickets);
    const calls: string[][] = [];
    let index = 0;
    const script: readonly PublishCommandResult[] = [
      ok(),
      { ...ok("a pull request already exists for this branch\n"), code: 1 },
      ok(PR_URL),
    ];
    const deps = {
      config: config(),
      tickets,
      policy: composeRuntimePolicy(),
      sessionId: "s1",
      readLayout: () => Promise.resolve(layout()),
      startCommand: ((command: { argv: readonly string[] }) => {
        calls.push([...command.argv]);
        const result = script[index++] ?? ok();
        return { result: Promise.resolve(result), cancel: () => {} };
      }) as never,
    };

    const first = await runPush(deps, created.ticket);
    assert.strictEqual(first.phase, "pushed");
    assert.strictEqual(first.reason, "the open_pr exited 1");
    assert.match(first.outputHead ?? "", /already exists/);
    assert.strictEqual(first.failedPhase, undefined);

    const second = await runPush(deps, created.ticket);
    assert.strictEqual(second.phase, "pr-open");
    assert.strictEqual(second.prUrl, PR_URL);
    assert.strictEqual(second.reason, undefined);
    // The push ran once; the pull request was attempted twice.
    assert.deepStrictEqual(calls.map((call) => call[0]), ["git", "gh", "gh"]);
  });

  it("leaves the ticket pushed when open_pr prints no URL", async () => {
    const { run } = setup({ script: [ok(), ok("Created pull request\n")] });
    const view = await run;
    assert.strictEqual(view.phase, "pushed");
    assert.strictEqual(
      view.reason,
      "open_pr succeeded but printed no pull request URL",
    );
  });

  it("records a command that cannot start as the pull request's failure", async () => {
    const { run } = setup({ script: [ok(), new Error("the runner died")] });
    const view = await run;
    assert.strictEqual(view.phase, "pushed");
    assert.match(view.reason ?? "", /could not run: the runner died/);
  });
});

describe("publish push: the refusals", () => {
  it("throws for an unknown ticket", async () => {
    const tickets = new PublishTickets({ ttlMs: 3_600_000 });
    await assert.rejects(
      () =>
        runPush(
          {
            config: config(),
            tickets,
            policy: composeRuntimePolicy(),
            sessionId: "s1",
          },
          "00000000-0000-0000-0000-000000000000",
        ),
      (error: unknown) => {
        assert.ok(error instanceof CommandExecutionError);
        assert.match(error.message, /holds no such publish ticket/);
        return true;
      },
    );
  });

  it("throws for a ticket in gated or failed", async () => {
    for (const phase of ["gated", "failed"] as const) {
      const { calls, run } = setup({ phase });
      await assert.rejects(
        () => run,
        (error: unknown) => {
          assert.ok(error instanceof CommandExecutionError);
          assert.match(error.message, new RegExp(phase));
          return true;
        },
      );
      assert.deepStrictEqual(calls, []);
    }
  });

  it("throws when push or open_pr is unset", async () => {
    for (
      const partial of [
        { openPr: undefined },
        { push: undefined },
      ] as const
    ) {
      const tickets = new PublishTickets({ ttlMs: 3_600_000 });
      const created = gated(tickets);
      const calls: string[][] = [];
      const deps = {
        config: { ...config(), ...partial } as PublishConfig,
        tickets,
        policy: composeRuntimePolicy(),
        sessionId: "s1",
        readLayout: () => Promise.resolve(layout()),
        startCommand: ((command: { argv: readonly string[] }) => {
          calls.push([...command.argv]);
          return { result: Promise.resolve(ok()), cancel: () => {} };
        }) as never,
      };
      await assert.rejects(
        () => runPush(deps, created.ticket),
        (error: unknown) => {
          assert.ok(error instanceof CommandExecutionError);
          assert.match(error.message, /no push or open_pr command/);
          return true;
        },
      );
      assert.deepStrictEqual(calls, []);
      assert.strictEqual(tickets.get("s1", created.ticket)?.phase, "ready");
    }
  });

  it("returns the ticket's own view when it expired mid-read", async () => {
    let now = 1_000;
    const tickets = new PublishTickets({ ttlMs: 1_000, now: () => now });
    const created = gated(tickets);
    const view = await runPush(
      {
        config: config(),
        tickets,
        policy: composeRuntimePolicy(),
        sessionId: "s1",
        readLayout: () => {
          // The ticket's lifetime runs out while the pins are being read.
          now += 5_000;
          return Promise.resolve(layout());
        },
        startCommand: (() => {
          throw new Error("nothing may start");
        }) as never,
      },
      created.ticket,
    );
    assert.strictEqual(view.phase, "expired");
    assert.strictEqual(tickets.get("s1", created.ticket)?.phase, "expired");
  });
});
