import { assertStrictEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { MemoryStore } from "../store/mod.ts";
import { serveWorkbenchUnix } from "../server/main.ts";
import { connectUnixClient } from "../transport/mod.ts";
import { turnResult as result } from "../../testing/builders/turn-client.ts";
import { MapEnv } from "../../testing/fakes/map-env.ts";
import { udsTestSocket } from "../../testing/servers/uds-sockets.ts";
import type { CliConfig } from "./args.ts";
import { socketTurn } from "./turn-client.ts";

function cfg(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    socket: "/tmp/dyfj-test.sock",
    mode: "turn",
    color: false,
    ...overrides,
  };
}

describe("socketTurn over a real Unix socket (integration)", () => {
  it("streams deltas and returns the receipt across the wire", async () => {
    const sock = udsTestSocket("cli-turn-roundtrip");
    const server = await serveWorkbenchUnix(sock, {
      store: new MemoryStore(),
      // A hermetic environment: the lane grants no process env to the turn.
      env: new MapEnv(),
      // Stub runtime: stream two deltas, then return a receipt. Cast loosely so
      // the test need not import the engine's runtime result type.
      // deno-lint-ignore no-explicit-any
      runRuntime: (async (input: any) => {
        input.frames?.onTextDelta?.("Hello ");
        input.frames?.onTextDelta?.("socket");
        return result({ text: "Hello socket" });
        // deno-lint-ignore no-explicit-any
      }) as any,
    });
    try {
      const deltas: string[] = [];
      const r = await socketTurn(
        cfg({ unix: true, socket: sock }),
        { prompt: "hi" },
        { onDelta: (t) => deltas.push(t) },
        connectUnixClient,
      );
      assertStrictEquals(deltas.join(""), "Hello socket");
      assertStrictEquals(r.text, "Hello socket");
    } finally {
      await server.close();
      await Deno.remove(sock).catch(() => {});
    }
  });
});
