import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { fakeIo } from "../../../testing/fakes/fake-io.ts";
import type { CliConfig } from "../args.ts";
import { runStart, type StartRuntimeFn } from "./start.ts";

function cfg(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    socket: "/tmp/dyfj-test.sock",
    mode: "turn",
    color: false,
    ...overrides,
  };
}

describe("runtime lifecycle commands", () => {
  it("runStart delegates to the runtime starter", async () => {
    const { io, stderr } = fakeIo();
    const calls: string[] = [];
    const starter: StartRuntimeFn = (config) => {
      calls.push(config.socket);
      return Promise.resolve(0);
    };
    const code = await runStart(cfg({ socket: "/run/wb.sock" }), io, starter);
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(calls, ["/run/wb.sock"]);
    assert.ok(
      stderr.join("\n").includes("foreground process"),
      `expected stderr.join("\\n") to include "foreground process"`,
    );
  });

  it("runStart describes the autostarted signal posture accurately", async () => {
    const { io, stderr } = fakeIo();
    let receivedAutostarted: boolean | undefined;
    const code = await runStart(
      cfg(),
      io,
      (_config, options) => {
        receivedAutostarted = options?.autostarted;
        return Promise.resolve(0);
      },
      true,
    );

    assert.strictEqual(code, 0);
    assert.strictEqual(receivedAutostarted, true);
    assert.ok(
      stderr.join("\n").includes("autostarted process"),
      `expected stderr.join("\\n") to include "autostarted process"`,
    );
    assert.ok(
      stderr.join("\n").includes("leaves the runtime running"),
      `expected stderr.join("\\n") to include "leaves the runtime running"`,
    );
    assert.ok(!(stderr.join("\n")).includes("foreground process"));
  });

  it("runStart fails with a precise fallback command", async () => {
    const { io, stderr } = fakeIo();
    const code = await runStart(cfg(), io, () => {
      throw new Error("permission denied");
    });
    assert.strictEqual(code, 1);
    assert.ok(
      stderr.join("\n").includes("could not start"),
      `expected stderr.join("\\n") to include "could not start"`,
    );
    assert.ok(
      stderr.join("\n").includes(
        "cd prototype && DYFJ_SOCKET='/tmp/dyfj-test.sock' node --env-file-if-exists=.env src/server/main.ts",
      ),
      "expected the Node fallback command",
    );
    assert.ok(
      !stderr.join("\n").includes("deno"),
      "expected the fallback to name no deno command",
    );
  });

  it("the fallback command keeps the requested socket, quoted for the shell", async () => {
    const socket = "/tmp/dyfj uat/it's.sock";
    const { io, stderr } = fakeIo();
    const code = await runStart(cfg({ socket }), io, () => {
      throw new Error("permission denied");
    });
    assert.strictEqual(code, 1);
    const line = stderr.join("\n").split("\n").find((text) =>
      text.startsWith("dyfj: fallback command: ")
    );
    const assignment = line?.match(/ (DYFJ_SOCKET=.*) node /)?.[1];
    assert.ok(assignment, `expected a DYFJ_SOCKET assignment in ${line}`);
    // The shell reads it back as the one path the client resolved.
    const echoed = execFileSync(
      "/bin/sh",
      ["-c", `${assignment} /usr/bin/printenv DYFJ_SOCKET`],
      { encoding: "utf8", env: {} },
    );
    assert.strictEqual(echoed, `${socket}\n`);
  });

  // Every client error printer must share one discipline: runStart's printer
  // needs the same oversized-case pin socketError carries.
  it("runStart truncates an oversized runtime-start error the same way as socketError", async () => {
    const payload = "x".repeat(200_000);
    const { io, stderr } = fakeIo();
    const code = await runStart(cfg(), io, () => {
      throw new Error(payload);
    });
    assert.strictEqual(code, 1);
    const out = stderr.join("\n");
    assert.ok(!out.includes(payload));
    const errorLine = stderr.find((line) => line.includes("could not start"))!;
    assert.ok(
      errorLine.includes("Error"),
      `expected ${JSON.stringify(errorLine)} to include "Error"`,
    );
    assert.ok(
      errorLine.includes(`${payload.length} bytes`),
      `expected ${
        JSON.stringify(errorLine)
      } to include \`\${payload.length} bytes\``,
    );
    assert.ok(errorLine.length < 1000);
  });
});
