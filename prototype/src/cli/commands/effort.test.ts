import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fakeIo } from "../../../testing/fakes/fake-io.ts";
import type { CliConfig } from "../args.ts";
import type { ConnectFn } from "../io.ts";
import { formatPostureLine } from "../posture.ts";
import { handleReplEffortCommand } from "./effort.ts";

const CODEX = "codex-chatgpt/gpt-6.1-sol";

function cfg(overrides: Partial<CliConfig> = {}): CliConfig {
  return { socket: "/tmp/dyfj-test.sock", mode: "turn", color: false, ...overrides };
}

function connect(runtime: Record<string, unknown> = {}): ConnectFn {
  return () =>
    Promise.resolve({
      request: (method: string) =>
        method === "models/list"
          ? Promise.resolve({
            models: [
              { slug: CODEX, tier: 2, local: false },
              { slug: "local-small", tier: 0, local: true },
            ],
          })
          : method === "runtime/status"
          ? Promise.resolve({ runtime })
          : Promise.resolve({}),
      close: () => {},
    });
}

describe("/effort", () => {
  it("is not handled for another command", async () => {
    const { io } = fakeIo();
    assert.strictEqual(
      await handleReplEffortCommand("/effortless", cfg(), io, connect()),
      false,
    );
  });

  it("sets a Codex model's effort from the next turn and shows it in the posture line", async () => {
    const { io, stderr } = fakeIo();
    const config = cfg({ model: CODEX });
    assert.strictEqual(
      await handleReplEffortCommand("/effort high", config, io, connect()),
      true,
    );
    assert.strictEqual(config.effort, "high");
    const out = stderr.join("\n");
    assert.match(out, /reasoning effort high from the next turn/);
    assert.match(out, /posture: codex-chatgpt\/gpt-6\.1-sol .* effort high/);
  });

  it("shows the runtime's default when the session set none, and clears back to it", async () => {
    const { io, stderr } = fakeIo();
    const config = cfg({ model: CODEX, effort: "xhigh" });
    await handleReplEffortCommand(
      "/effort default",
      config,
      io,
      connect({ codexReasoningEffort: "medium" }),
    );
    assert.strictEqual(config.effort, undefined);
    await handleReplEffortCommand(
      "/effort",
      config,
      io,
      connect({ codexReasoningEffort: "medium" }),
    );
    assert.match(stderr.join("\n"), /reasoning effort: medium \(runtime default\)/);
  });

  it("refuses a model off the Codex route and a level the route does not accept", async () => {
    const { io, stderr } = fakeIo();
    const local = cfg({ model: "local-small" });
    await handleReplEffortCommand("/effort high", local, io, connect());
    assert.strictEqual(local.effort, undefined);
    assert.match(stderr.join("\n"), /applies only to codex-chatgpt models/);

    const codex = cfg({ model: CODEX });
    await handleReplEffortCommand("/effort max", codex, io, connect());
    assert.strictEqual(codex.effort, undefined);
    assert.match(stderr.join("\n"), /usage: \/effort \[low\|medium\|high\|xhigh\|default\]/);
  });

  it("clears an effort with /effort default even off the Codex route", async () => {
    const { io, stderr } = fakeIo();
    const local = cfg({ model: "local-small", effort: "high" });
    await handleReplEffortCommand("/effort default", local, io, connect());
    assert.strictEqual(local.effort, undefined);
    assert.match(stderr.join("\n"), /reasoning effort cleared/);
  });

  it("names no new Codex session when the effort does not change", async () => {
    const { io, stderr } = fakeIo();
    const config = cfg({ model: CODEX, effort: "high" });
    await handleReplEffortCommand("/effort high", config, io, connect());
    const out = stderr.join("\n");
    assert.match(out, /reasoning effort stays high/);
    assert.doesNotMatch(out, /new Codex session/);
  });

  it("formatPostureLine names the effort when one is given", () => {
    assert.match(
      formatPostureLine({
        slug: CODEX,
        tier: 2,
        local: false,
        approvePaidSession: true,
        effort: "xhigh",
      }),
      /^posture: codex-chatgpt\/gpt-6\.1-sol · tier 2 · hosted · effort xhigh · /,
    );
  });
});
