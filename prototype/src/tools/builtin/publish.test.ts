import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { after, describe, it } from "node:test";
import {
  composeRuntimePolicy,
  parsePublishConfig,
  type PublishConfig,
  REFUSED_PROGRAMS,
} from "../../config/mod.ts";
import { RootAnchors } from "./root-anchors.ts";
import type { GitLayout } from "./publish-git.ts";
import type {
  PublishCommand,
  PublishCommandHandle,
  PublishCommandResult,
} from "./publish-run.ts";
import { PublishTickets } from "./publish-tickets.ts";
import {
  definePublishTools,
  findingLines,
  FINDING_LINES,
  HOST_EXECUTION_WARNING,
  renderTicket,
} from "./publish.ts";
import { createCommandRegistry } from "../registry.ts";
import { invokeCommand } from "../invoke.ts";
import { evaluateCommandPolicy } from "../policy.ts";
import type { CommandCall, CommandDefinition } from "../definition.ts";

const posix = process.platform !== "win32";

const LAYOUT: GitLayout = {
  gitDir: "/repo/.git/worktrees/bit-786",
  commonDir: "/repo/.git",
  topLevel: "/repo",
  branchRef: "refs/heads/chris/bit-786-host-publish-tool",
  head: "0123456789abcdef0123456789abcdef01234567",
};

/**
 * A real directory to anchor, for the whole file. The publish tools verify the
 * workspace against the runtime's anchors, which canonicalize the path, so a
 * made-up root fails before any phase runs.
 */
// Realpath'd: a report directory must resolve to itself, and macOS bridges
// /tmp to /private/tmp.
const ROOT = realpathSync(await mkdtemp(join(tmpdir(), "dyfj-publish-tool-")));
// Synchronous: an async reap leaves FS requests live past the file's handle
// check.
after(() => rmSync(ROOT, { recursive: true, force: true }));

/** The session's layout, in the anchored root. */
function layoutIn(root: string): GitLayout {
  return { ...LAYOUT, topLevel: root, gitDir: join(root, ".git") };
}

function config(overrides: Partial<PublishConfig> = {}): PublishConfig {
  return {
    preGate: ["./pre-gate", "--range={range}"],
    gate: ["./gate", "--report={report}", "--head={head}"],
    reportPath: join(ROOT, "reports", "{ticket}.log"),
    gateTimeoutMs: 600_000,
    ticketTtlMs: 3_600_000,
    ...overrides,
  };
}

/** A stub runner: each call resolves with the next scripted result. */
function stubRunner(script: readonly PublishCommandResult[]) {
  const calls: PublishCommand[] = [];
  let index = 0;
  const handles: PublishCommandHandle[] = [];
  const start = (command: PublishCommand): PublishCommandHandle => {
    calls.push(command);
    const result = script[index++] ?? {
      code: 0,
      timedOut: false,
      cancelled: false,
      output: "",
      truncated: false,
      pipesLeftOpen: false,
    };
    let cancel = () => {};
    const handle: PublishCommandHandle = {
      result: Promise.resolve(result),
      cancel: () => {
        cancel = () => {};
      },
    };
    void cancel;
    handles.push(handle);
    return handle;
  };
  return { calls, start, handles };
}

function tools(
  options: {
    config?: PublishConfig;
    runner?: ReturnType<typeof stubRunner>;
    layout?: GitLayout;
    workspace?: string;
    tickets?: PublishTickets;
    implementer?: string;
  } = {},
) {
  const tickets = options.tickets ??
    new PublishTickets({ ttlMs: 3_600_000 });
  const root = options.workspace ?? ROOT;
  const registry = createCommandRegistry();
  for (
    const command of definePublishTools({
      config: options.config ?? config(),
      tickets,
      policy: composeRuntimePolicy(),
      sessionId: "session-1",
      workspaceRoot: root,
      rootAnchors: new RootAnchors(),
      readLayout: async () => options.layout ?? layoutIn(root),
      resolveImplementer: () =>
        Promise.resolve(options.implementer ?? "claude-opus-5"),
      ...(options.runner === undefined
        ? {}
        : { startCommand: options.runner.start }),
    })
  ) {
    registry.register(command);
  }
  return { registry, tickets };
}

let callCounter = 0;
function call(commandId: string, args: Record<string, unknown> = {}): CommandCall {
  callCounter += 1;
  return {
    commandId,
    callId: `call-${callCounter}`,
    caller: { principalId: "workbench", principalType: "agent" },
    arguments: args,
  };
}

/** Wait for the detached phases to settle: they append a report per phase. */
async function settle(tickets: PublishTickets): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const phase = tickets.latest("session-1")?.phase;
    if (phase === "ready" || phase === "failed") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the phases did not settle");
}

/** The text a successful call returned; asserts the call succeeded. */
function textOf(result: Awaited<ReturnType<typeof invokeCommand>>): string {
  assert.ok(!result.isError, result.isError ? result.reason : "");
  return result.result as string;
}

async function invoke(
  registry: ReturnType<typeof createCommandRegistry>,
  commandCall: CommandCall,
) {
  return await invokeCommand(registry, commandCall, () =>
    Promise.resolve({ decision: "approve" })
  );
}

describe("publish tools: what the model sees", () => {
  it("names host execution in the start prompt's title", () => {
    const { registry } = tools();
    const start = registry.lookup("publish/start");
    assert.ok(start !== undefined);
    assert.match(start.title, /host, outside the sandbox/);
    assert.ok(start.description.includes(HOST_EXECUTION_WARNING));
  });

  it("is never grantable and never auto-allowed", () => {
    const { registry } = tools();
    for (const id of ["publish/start", "publish/cancel"]) {
      const command = registry.lookup(id)!;
      assert.strictEqual(command.grantable, undefined);
      const verdict = evaluateCommandPolicy(
        command,
        call(id, id === "publish/start" ? { issue: "BIT-786" } : {}),
        { permissionLevel: "operator", loopback: true },
      );
      assert.strictEqual(
        verdict.decision,
        "ask",
        `${id} must ask even under the operator posture`,
      );
    }
  });

  it("is registered only when a root and a config are present", async () => {
    const { registry } = tools();
    assert.deepStrictEqual(registry.list().map((c) => c.id).sort(), [
      "publish/cancel",
      "publish/start",
      "publish/status",
    ]);
  });

  it("refuses a non-identifier issue before running anything", async () => {
    const runner = stubRunner([]);
    const { registry } = tools({ runner });
    const result = await invoke(registry, call("publish/start", { issue: "not an id" }));
    assert.strictEqual(result.isError, true);
    assert.strictEqual(runner.calls.length, 0);
  });
});

describe("publish tools: start", () => {
  it("returns a ticket at once and runs the phases detached", async () => {
    const runner = stubRunner([
      { code: 0, timedOut: false, cancelled: false, output: "pre ok", truncated: false, pipesLeftOpen: false },
      { code: 0, timedOut: false, cancelled: false, output: "gate ok", truncated: false, pipesLeftOpen: false },
    ]);
    const { registry, tickets } = tools({ runner });
    const result = await invoke(registry, call("publish/start"));
    assert.strictEqual(result.isError, false);
    const text = result.result as string;
    assert.match(text, /phase: pre-gate/);
    assert.match(text, new RegExp(`head: ${LAYOUT.head}`));
    // Both phases started with the operator's own argv, filled host-side.
    assert.deepStrictEqual(runner.calls[0]?.argv, [
      "./pre-gate",
      "--range=origin/main...HEAD",
    ]);
    await settle(tickets);
    const ticket = tickets.latest("session-1")!.ticket;
    assert.deepStrictEqual(runner.calls[1]?.argv, [
      "./gate",
      `--report=${ROOT}/reports/${ticket}.log`,
      `--head=${LAYOUT.head}`,
    ]);
    // The gate ran in the session's repository, not in the runtime's own cwd.
    assert.strictEqual(runner.calls[0]?.cwd, ROOT);
    // The ticket records the phases as they finish.
    await settle(tickets);
    const view = tickets.latest("session-1");
    assert.strictEqual(view?.phase, "ready");
  });

  it("stops at a failing pre-gate, without running the gate", async () => {
    const runner = stubRunner([
      { code: 2, timedOut: false, cancelled: false, output: "pre failed", truncated: false, pipesLeftOpen: false },
    ]);
    const { registry, tickets } = tools({ runner });
    await invoke(registry, call("publish/start"));
    await settle(tickets);
    assert.strictEqual(runner.calls.length, 1);
    const view = tickets.latest("session-1");
    assert.strictEqual(view?.phase, "failed");
    assert.strictEqual(view?.failedPhase, "pre-gate");
    assert.match(view?.reason ?? "", /exited 2/);
    assert.match(view?.outputHead ?? "", /pre failed/);
  });

  it("reports a timed-out phase and its tail", async () => {
    const runner = stubRunner([
      { code: 0, timedOut: false, cancelled: false, output: "pre ok", truncated: false, pipesLeftOpen: false },
      { code: null, timedOut: true, cancelled: false, output: "gate hung", truncated: true, pipesLeftOpen: false },
    ]);
    const { registry, tickets } = tools({ runner });
    await invoke(registry, call("publish/start"));
    await settle(tickets);
    const view = tickets.latest("session-1");
    assert.strictEqual(view?.failedPhase, "gate");
    assert.match(view?.reason ?? "", /deadline/);
    assert.strictEqual(view?.truncatedOutput, true);
  });

  it("gives the gate the session's ticket and issue placeholders", async () => {
    const runner = stubRunner([
      { code: 0, timedOut: false, cancelled: false, output: "", truncated: false, pipesLeftOpen: false },
      { code: 0, timedOut: false, cancelled: false, output: "", truncated: false, pipesLeftOpen: false },
    ]);
    const { registry, tickets } = tools({
      runner,
      config: config({
        gate: ["./gate", "--ticket={ticket}", "--issue={issue}", "--repo={repo}"],
      }),
    });
    await invoke(registry, call("publish/start", { issue: "BIT-786" }));
    await settle(tickets);
    const view = tickets.latest("session-1")!;
    assert.deepStrictEqual(runner.calls[1]?.argv, [
      "./gate",
      `--ticket=${view.ticket}`,
      "--issue=BIT-786",
      `--repo=${ROOT}`,
    ]);
  });

  it("hands every child the hardened environment", async () => {
    const runner = stubRunner([]);
    const { registry } = tools({ runner });
    await invoke(registry, call("publish/start"));
    const env = runner.calls[0]?.env ?? {};
    // The git keys travel to the operator's own git, not only to ours.
    const count = Number(env["GIT_CONFIG_COUNT"]);
    assert.ok(Number.isSafeInteger(count) && count > 0);
    const keys = Array.from(
      { length: count },
      (_, index) => env[`GIT_CONFIG_KEY_${index}`],
    );
    for (const required of ["core.hooksPath", "core.fsmonitor", "core.sshCommand"]) {
      assert.ok(keys.includes(required), `missing ${required}`);
    }
    assert.strictEqual(env["GIT_TERMINAL_PROMPT"], "0");
    assert.strictEqual(env["GIT_CONFIG_NOSYSTEM"], "1");
    // No runtime credential goes to a gate.
    for (const forbidden of ["ANTHROPIC_API_KEY", "DOLT_PASSWORD", "DYFJ_SOCKET"]) {
      assert.ok(!(forbidden in env), `${forbidden} must not travel`);
    }
  });
});

describe("publish tools: status and cancel", () => {
  it("reports unknown when the runtime holds no ticket", async () => {
    const { registry } = tools();
    const result = await invoke(registry, call("publish/status"));
    assert.match(textOf(result), /^unknown:/);
  });

  it("reports the newest ticket when none is named", async () => {
    const pass = {
      code: 0,
      timedOut: false,
      cancelled: false,
      output: "",
      truncated: false,
      pipesLeftOpen: false,
    };
    const { registry, tickets } = tools({ runner: stubRunner([pass, pass]) });
    await invoke(registry, call("publish/start"));
    await settle(tickets);
    const result = await invoke(registry, call("publish/status"));
    assert.match(textOf(result), /phase: ready/);
  });

  it("shows the report path and findings for a failed run", async () => {
    const runner = stubRunner([
      { code: 1, timedOut: false, cancelled: false, output: "boom", truncated: false, pipesLeftOpen: false },
    ]);
    const { registry, tickets } = tools({ runner });
    await invoke(registry, call("publish/start"));
    await settle(tickets);
    const result = await invoke(registry, call("publish/status"));
    const text = textOf(result);
    assert.match(text, new RegExp(`^report: ${ROOT}/reports/`, "m"));
    assert.match(text, /findings \(first 10 non-empty lines\)/);
    assert.match(text, /boom/);
  });

  it("cancels a running gate and records it", async () => {
    let cancelled = false;
    const registry = createCommandRegistry();
    const tickets = new PublishTickets({ ttlMs: 3_600_000 });
    let release: (result: PublishCommandResult) => void = () => {};
    for (
      const command of definePublishTools({
        config: config(),
        tickets,
        policy: composeRuntimePolicy(),
        sessionId: "session-1",
        workspaceRoot: ROOT,
        rootAnchors: new RootAnchors(),
        readLayout: async () => layoutIn(ROOT),
        resolveImplementer: async () => "claude-opus-5",
        startCommand: () => ({
          result: new Promise<PublishCommandResult>((resolve) => {
            release = resolve;
          }),
          cancel: () => {
            cancelled = true;
            release({ code: null, timedOut: false, cancelled: true, output: "", truncated: false, pipesLeftOpen: false });
          },
        }),
      })
    ) {
      registry.register(command);
    }
    await invoke(registry, call("publish/start"));
    const status = await invoke(registry, call("publish/cancel"));
    assert.strictEqual(cancelled, true);
    assert.match(textOf(status), /cancelled by the operator/);
  });

  it("reports nothing to cancel for a finished ticket", async () => {
    const runner = stubRunner([]);
    const { registry, tickets } = tools({ runner });
    await invoke(registry, call("publish/start"));
    await settle(tickets);
    const result = await invoke(registry, call("publish/cancel"));
    assert.match(textOf(result), /nothing to cancel/);
  });
});

describe("publish tools: the report head", () => {
  it("keeps the first lines, capped, and says how many more there were", () => {
    const output = Array.from({ length: FINDING_LINES + 5 }, (_, i) => `line ${i}`)
      .join("\n");
    const head = findingLines(output, false);
    const lines = head.split("\n");
    // One note line, then the findings.
    assert.strictEqual(lines.length, FINDING_LINES + 1);
    assert.match(lines[0]!, /further lines not shown/);
    assert.strictEqual(lines[1], "line 0");
    assert.strictEqual(lines.at(-1), `line ${FINDING_LINES - 1}`);
    assert.match(findingLines("x", true), /earlier output dropped/);
  });

  it("caps one very long line", () => {
    const tail = findingLines("a".repeat(5_000), false);
    assert.ok(tail.length <= 301);
    assert.match(tail, /…$/);
  });
});

describe("publish tools: refusal paths", () => {
  it("starts nothing when the layout cannot be read", async () => {
    const registry = createCommandRegistry();
    for (
      const command of definePublishTools({
        config: config(),
        tickets: new PublishTickets({ ttlMs: 1_000 }),
        policy: composeRuntimePolicy(),
        sessionId: "session-1",
        workspaceRoot: ROOT,
        rootAnchors: new RootAnchors(),
        resolveImplementer: async () => "claude-opus-5",
        readLayout: async () => {
          throw new Error("not a git checkout");
        },
      })
    ) {
      registry.register(command);
    }
    const result = await invoke(registry, call("publish/start"));
    assert.strictEqual(result.isError, true);
    assert.match(result.reason, /not a git checkout/);
  });

  it("refuses a workspace with no commit to gate", async () => {
    const { registry } = tools({ layout: { ...LAYOUT, head: null } });
    const result = await invoke(registry, call("publish/start"));
    assert.strictEqual(result.isError, true);
    assert.match(result.reason, /no commit|not on a branch/);
  });

  it("never lets an operator command be a shell string", () => {
    // The refusal lives in the config loader, which owns what an argv may be.
    // The tool re-validates nothing: it starts exactly the argv it is handed.
    for (const interpreter of REFUSED_PROGRAMS) {
      assert.throws(
        () =>
          parsePublishConfig(
            { publish: { pre_gate: ["./pre-gate"], gate: [interpreter, "-c", "true"] } },
            "/config.toml",
          ),
        /shell or a text-evaluating runtime/,
        `${interpreter} must be refused`,
      );
    }
  });
});

describe("publish tools: real processes", () => {
  it(
    "runs a real gate command and reads its exit status",
    { skip: !posix },
    async () => {
      const registry = createCommandRegistry();
      const tickets = new PublishTickets({ ttlMs: 3_600_000 });
      for (
        const command of definePublishTools({
          config: config({
            // Real programs the config layer allows under those names.
            preGate: ["/usr/bin/true"],
            gate: ["/usr/bin/false"],
          }),
          tickets,
          policy: composeRuntimePolicy(),
          sessionId: "session-1",
          workspaceRoot: ROOT,
          rootAnchors: new RootAnchors(),
          resolveImplementer: async () => "claude-opus-5",
          readLayout: async () => layoutIn(ROOT),
        })
      ) {
        registry.register(command);
      }
      await invoke(registry, call("publish/start"));
      // The runner is real here, so wait for the phases to settle.
      for (let attempt = 0; attempt < 200; attempt++) {
        const view = tickets.latest("session-1");
        if (view?.phase === "failed" || view?.phase === "ready") break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const view = tickets.latest("session-1");
      assert.strictEqual(view?.phase, "failed");
      assert.strictEqual(view?.failedPhase, "gate", view?.reason ?? "");
      assert.match(view?.reason ?? "", /exited 1/);
    },
  );
});

describe("publish tools: an unresolvable implementer", () => {
  it("refuses the run before a ticket exists or a process starts", async () => {
    const runner = stubRunner([]);
    const registry = createCommandRegistry();
    const tickets = new PublishTickets({ ttlMs: 3_600_000 });
    for (
      const command of definePublishTools({
        config: config(),
        tickets,
        policy: composeRuntimePolicy(),
        sessionId: "session-1",
        workspaceRoot: ROOT,
        rootAnchors: new RootAnchors(),
        readLayout: async () => layoutIn(ROOT),
        // The session ran no model this tool can place.
        resolveImplementer: async () => undefined,
        startCommand: runner.start,
      })
    ) {
      registry.register(command);
    }
    const result = await invoke(registry, call("publish/start"));
    assert.strictEqual(result.isError, true);
    assert.match(
      result.isError ? result.reason : "",
      /cannot be resolved from its own record/,
    );
    assert.strictEqual(runner.calls.length, 0);
    assert.strictEqual(tickets.latest("session-1"), null);
  });
});

describe("publish tools: an untrusted layout refuses before anything runs", () => {
  it("publish/start refuses a shared config with an include", async () => {
    const root = realpathSync(await mkdtemp(join(tmpdir(), "dyfj-publish-inc-")));
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
    execFileSync("git", ["init", "-q", "-b", "work", root], { env, stdio: "ignore" });
    execFileSync("git", ["-C", root, "commit", "-q", "--allow-empty", "-m", "x"], {
      env,
      stdio: "ignore",
    });
    execFileSync(
      "git",
      ["-C", root, "config", "include.path", join(root, "extra.cfg")],
      { env, stdio: "ignore" },
    );
    try {
      const runner = stubRunner([]);
      const tickets = new PublishTickets({ ttlMs: 3_600_000 });
      const registry = createCommandRegistry();
      for (
        const command of definePublishTools({
          config: config({ reportPath: join(root, "reports", "{ticket}.log") }),
          tickets,
          policy: composeRuntimePolicy(),
          sessionId: "session-1",
          workspaceRoot: root,
          rootAnchors: new RootAnchors(),
          resolveImplementer: async () => "claude-opus-5",
          startCommand: runner.start,
        })
      ) {
        registry.register(command);
      }
      const result = await invoke(registry, call("publish/start"));
      assert.strictEqual(result.isError, true);
      assert.match(
        result.isError ? result.reason : "",
        /has an include/,
      );
      assert.strictEqual(runner.calls.length, 0, "nothing may start");
      assert.strictEqual(tickets.latest("session-1"), null, "no ticket");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("publish tools: refused before the approval prompt", () => {
  /** A registry whose layout reads and implementer answer are scripted. */
  function scripted(options: {
    readLayout: () => Promise<GitLayout>;
    implementer?: string | undefined;
  }) {
    const tickets = new PublishTickets({ ttlMs: 3_600_000 });
    const runner = stubRunner([]);
    const registry = createCommandRegistry();
    for (
      const command of definePublishTools({
        config: config(),
        tickets,
        policy: composeRuntimePolicy(),
        sessionId: "session-1",
        workspaceRoot: ROOT,
        rootAnchors: new RootAnchors(),
        readLayout: options.readLayout,
        resolveImplementer: async () =>
          "implementer" in options ? options.implementer : "claude-opus-5",
        startCommand: runner.start,
      })
    ) {
      registry.register(command);
    }
    let prompts = 0;
    const start = () =>
      invokeCommand(registry, call("publish/start"), () => {
        prompts += 1;
        return Promise.resolve({ decision: "approve" });
      });
    return { start, tickets, runner, prompts: () => prompts };
  }

  it("refuses a layout that cannot be read without asking", async () => {
    const s = scripted({
      readLayout: () => Promise.reject(new Error("extensions.worktreeConfig is on")),
    });
    const result = await s.start();
    assert.strictEqual(result.isError, true);
    assert.match(result.isError ? result.reason : "", /cannot start/);
    assert.strictEqual(s.prompts(), 0);
    assert.strictEqual(s.tickets.latest("session-1"), null);
  });

  it("refuses a session with no implementer without asking", async () => {
    const s = scripted({
      readLayout: async () => layoutIn(ROOT),
      implementer: undefined,
    });
    const result = await s.start();
    assert.strictEqual(result.isError, true);
    assert.strictEqual(s.prompts(), 0);
  });

  it("still asks on every start that can begin", async () => {
    const s = scripted({ readLayout: async () => layoutIn(ROOT) });
    await s.start();
    await s.start();
    assert.strictEqual(s.prompts(), 2);
  });

  it("refuses after approval when the layout changed during the prompt", async () => {
    let reads = 0;
    const s = scripted({
      readLayout: async () => {
        reads += 1;
        if (reads === 1) return layoutIn(ROOT);
        throw new Error("the repository moved");
      },
    });
    const result = await s.start();
    assert.strictEqual(result.isError, true);
    assert.strictEqual(s.prompts(), 1);
    assert.strictEqual(s.runner.calls.length, 0);
    assert.strictEqual(s.tickets.latest("session-1"), null);
  });
});
