/**
 * Server-console canary leak test (integration).
 *
 * Behavioral guard for the privacy invariant on the transport server: named
 * turn and private-memory canaries must not reach the console methods used by
 * server narration. Static review cannot reliably protect this invariant (it
 * emerges from the composition of the turn core and its transport callers),
 * so the test runs a REAL turn through the REAL server path with a canary
 * private memory injected and captures log/info/debug/warn/error during it.
 *
 * The aggregate integration fixture provides the isolated Dolt sql-server;
 * this test adds and removes only its canary rows there, then stands up a
 * loopback stub that speaks the OpenAI-compatible
 * chat/completions wire as the "model".
 */

import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "@std/assert";
import { udsTestSocket } from "../../testing/servers/uds-sockets.ts";
import { startModelServer } from "../../testing/servers/model-server.ts";
import { MapEnv } from "../../testing/fakes/map-env.ts";
import { serveWorkbenchUnix } from "./main.ts";
import { connectUnixClient } from "../transport/mod.ts";
import {
  openFixtureSql,
  openFixtureStore,
} from "../../testing/dolt/fixture-sql.ts";

const MEMORY_SLUG = "canary_leak_test_cf9a";
const MEMORY_NAME = "CANARY-MEMORY-NAME-cf9a";
const MEMORY_CONTENT = "CANARY-MEMORY-CONTENT-cf9a private and load-bearing";
const MODEL_SLUG = "canary-stub-model-cf9a";
const STUB_REPLY = "CANARY-STUB-REPLY-cf9a the turn text itself";

Deno.test("a real turn keeps its canaries out of narration console methods", async () => {
  const stub = startModelServer(() => ({
    kind: "text",
    text: STUB_REPLY,
    usage: { promptTokens: 7, completionTokens: 9 },
  }));
  const sql = openFixtureSql();
  const store = openFixtureStore();
  const socketPath = udsTestSocket("server-console-canary");
  try {
    await sql.query(
      "INSERT INTO memories (memory_id, slug, type, visibility, inject, name, description, content) " +
        "VALUES (?, ?, 'user', 'private', 'always', ?, 'canary row for the console leak test', ?)",
      [`mem_${MEMORY_SLUG}`, MEMORY_SLUG, MEMORY_NAME, MEMORY_CONTENT],
    );
    await sql.query(
      "INSERT INTO models (slug, display_name, provider, api, base_url, tier, " +
        "context_window, max_output_tokens, cost_input, cost_output, " +
        "cost_cache_read, cost_cache_write, reasoning, capabilities, active) " +
        "VALUES (?, 'Canary Stub', 'mlx-lm', 'openai-completions', ?, 0, " +
        "8192, 1024, 0, 0, 0, 0, FALSE, ?, TRUE)",
      [MODEL_SLUG, stub.baseUrl, '["text"]'],
    );
    // The turn's env-derived defaults come from an empty env, not the
    // lane's process env, which grants only the fixture's keys.
    const server = await serveWorkbenchUnix(socketPath, {
      store,
      env: new MapEnv(),
    });
    try {
      const captured: string[] = [];
      const original = {
        log: console.log,
        info: console.info,
        debug: console.debug,
        warn: console.warn,
        error: console.error,
      };
      const record =
        (level: keyof typeof original) => (...parts: unknown[]) => {
          captured.push(`${level}: ${parts.map(String).join(" ")}`);
        };
      console.log = record("log");
      console.info = record("info");
      console.debug = record("debug");
      console.warn = record("warn");
      console.error = record("error");

      let result: { text?: string };
      try {
        const client = await connectUnixClient(server.socketPath, {
          onStream: () => {},
        });
        try {
          result = await client.request("turn", {
            prompt: "canary leak integration test turn",
            routingOptions: { modelId: MODEL_SLUG },
          }) as { text?: string };
        } finally {
          client.close();
        }
      } finally {
        console.log = original.log;
        console.info = original.info;
        console.debug = original.debug;
        console.warn = original.warn;
        console.error = original.error;
      }

      // The turn really ran end to end through the stub model.
      assertStringIncludes(result.text ?? "", STUB_REPLY);

      const consoleOutput = captured.join("\n");
      assertMatch(consoleOutput, /^error: \[turn\] session=/m);
      // The canary must never reach the captured narration methods: not the
      // private memory name, its content, or the model's response text.
      for (const canary of [MEMORY_NAME, MEMORY_CONTENT, STUB_REPLY]) {
        assert(!consoleOutput.includes(canary), `console leaked ${canary}`);
      }
      // Nor any memory-index narration of the receipt.
      assertEquals(consoleOutput.includes("memory-index:"), false);
    } finally {
      await server.close();
    }
  } finally {
    await stub.close();
    await sql.query("DELETE FROM memories WHERE slug = ?", [MEMORY_SLUG]);
    await sql.query("DELETE FROM models WHERE slug = ?", [MODEL_SLUG]);
    await sql.close();
    await store.close();
    try {
      await Deno.remove(socketPath);
    } catch {
      // already gone
    }
  }
});
