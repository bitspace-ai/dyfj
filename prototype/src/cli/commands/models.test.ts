import assert from "node:assert/strict";
import { describe, it } from "@std/testing/bdd";
import { fakeIo } from "../../../testing/fakes/fake-io.ts";
import type { CliConfig } from "../args.ts";
import type { ConnectFn } from "../io.ts";
import { runModels } from "./models.ts";

function cfg(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    socket: "/tmp/dyfj-test.sock",
    mode: "turn",
    color: false,
    ...overrides,
  };
}

describe("models/sessions over UDS", () => {
  function fakeConnect(responses: Record<string, unknown>): ConnectFn {
    return (_socketPath: string) =>
      Promise.resolve({
        request: (method: string) => Promise.resolve(responses[method]),
        close: () => {},
      });
  }

  it("runModels lists models from the seam", async () => {
    const { io, stdout } = fakeIo();
    const code = await runModels(
      cfg(),
      io,
      fakeConnect({
        "models/list": {
          models: [
            {
              slug: "gemma4",
              tier: 0,
              provider: "ollama",
              displayName: "Gemma 4",
            },
          ],
        },
      }),
    );
    assert.strictEqual(code, 0);
    assert.ok(stdout.join("").includes("gemma4"), `expected stdout.join("") to include "gemma4"`);
    assert.ok(stdout.join("").includes("Gemma 4"), `expected stdout.join("") to include "Gemma 4"`);
  });

  it("runModels annotates rows the server marked unroutable", async () => {
    const { io, stdout } = fakeIo();
    const code = await runModels(
      cfg(),
      io,
      fakeConnect({
        "models/list": {
          models: [
            {
              slug: "gemma4",
              tier: 0,
              provider: "ollama",
              displayName: "Gemma 4",
              routable: true,
            },
            {
              slug: "gpt-6-preview",
              tier: 2,
              provider: "openai",
              displayName: "GPT-6 Preview",
              routable: false,
            },
            // Older server: no flag — must not be smeared as unpriced.
            {
              slug: "claude-opus-4-8",
              tier: 2,
              provider: "anthropic",
              displayName: "Claude Opus 4.8",
            },
          ],
        },
      }),
    );
    assert.strictEqual(code, 0);
    const out = stdout.join("");
    const lines = out.split("\n");
    assert.ok((lines.find((l) => l.includes("gpt-6-preview")) ?? "").includes("[unpriced — not routable]"), `expected lines.find((l) => l.includes("gpt-6-preview")) ?? "" to include "[unpriced — not routable]"`);
    const gemma = lines.find((l) => l.includes("gemma4"));
    const opus = lines.find((l) => l.includes("claude-opus-4-8"));
    assert.ok(gemma !== undefined && opus !== undefined);
    assert.ok(!gemma.includes("unpriced"));
    assert.ok(!opus.includes("unpriced"));
  });

  it("a connection failure points the operator at dyfj start", async () => {
    const { io, stderr } = fakeIo();
    const code = await runModels(
      cfg({ socket: "/run/missing.sock" }),
      io,
      () => {
        throw new Error("No such file or directory (os error 2)");
      },
    );
    assert.strictEqual(code, 1);
    assert.ok(stderr.join("\n").includes("dyfj start"), `expected stderr.join("\\n") to include "dyfj start"`);
    assert.ok(stderr.join("\n").includes("/run/missing.sock"), `expected stderr.join("\\n") to include "/run/missing.sock"`);
  });
});
