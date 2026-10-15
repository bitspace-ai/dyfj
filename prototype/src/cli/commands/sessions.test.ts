import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fakeIo } from "../../../testing/fakes/fake-io.ts";
import type { CliConfig } from "../args.ts";
import type { ConnectFn } from "../io.ts";
import { runSessions } from "./sessions.ts";

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

  it("runSessions groups by project", async () => {
    const { io, stdout } = fakeIo();
    const code = await runSessions(
      cfg(),
      io,
      fakeConnect({
        "sessions/list": {
          projects: [
            {
              project: "dyfj",
              sessions: [{ slug: "s-1", sessionName: "Build" }],
            },
          ],
        },
      }),
    );
    assert.strictEqual(code, 0);
    const out = stdout.join("");
    assert.ok(
      out.includes("dyfj"),
      `expected ${JSON.stringify(out)} to include "dyfj"`,
    );
    assert.ok(
      out.includes("s-1"),
      `expected ${JSON.stringify(out)} to include "s-1"`,
    );
    assert.ok(
      out.includes("Build"),
      `expected ${JSON.stringify(out)} to include "Build"`,
    );
  });

  it("runSessions shows when each session last moved and a resume hint", async () => {
    const { io, stdout, stderr } = fakeIo();
    const code = await runSessions(
      cfg(),
      io,
      fakeConnect({
        "sessions/list": {
          projects: [
            {
              project: "dyfj",
              sessions: [{
                slug: "workbench-01ktz1xwcn7jmgs5e8kakfezkr",
                sessionName: "Build",
                updatedAt: "2026-07-05 09:12:33.123456",
              }],
            },
          ],
        },
      }),
    );
    assert.strictEqual(code, 0);
    assert.ok(
      stdout.join("").includes("2026-07-05 09:12"),
      `expected stdout.join("") to include "2026-07-05 09:12"`,
    );
    assert.ok(
      stderr.join("\n").includes("resume one with: dyfj --session"),
      `expected stderr.join("\\n") to include "resume one with: dyfj --session"`,
    );
  });
});
