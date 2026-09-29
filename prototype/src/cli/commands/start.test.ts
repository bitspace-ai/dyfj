import {
  assert,
  assertEquals,
  assertFalse,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
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
    assertStrictEquals(code, 0);
    assertEquals(calls, ["/run/wb.sock"]);
    assertStringIncludes(stderr.join("\n"), "foreground process");
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

    assertStrictEquals(code, 0);
    assertStrictEquals(receivedAutostarted, true);
    assertStringIncludes(stderr.join("\n"), "autostarted process");
    assertStringIncludes(stderr.join("\n"), "leaves the runtime running");
    assertFalse((stderr.join("\n")).includes("foreground process"));
  });

  it("runStart fails with a precise fallback command", async () => {
    const { io, stderr } = fakeIo();
    const code = await runStart(cfg(), io, () => {
      throw new Error("permission denied");
    });
    assertStrictEquals(code, 1);
    assertStringIncludes(stderr.join("\n"), "could not start");
    assertStringIncludes(stderr.join("\n"), "deno task serve-unix");
  });

  // Every client error printer must share one discipline: runStart's printer
  // needs the same oversized-case pin socketError carries.
  it("runStart truncates an oversized runtime-start error the same way as socketError", async () => {
    const payload = "x".repeat(200_000);
    const { io, stderr } = fakeIo();
    const code = await runStart(cfg(), io, () => {
      throw new Error(payload);
    });
    assertStrictEquals(code, 1);
    const out = stderr.join("\n");
    assertFalse(out.includes(payload));
    const errorLine = stderr.find((line) => line.includes("could not start"))!;
    assertStringIncludes(errorLine, "Error");
    assertStringIncludes(errorLine, `${payload.length} bytes`);
    assert(errorLine.length < 1000);
  });
});
