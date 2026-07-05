/**
 * Server-console canary leak test (integration).
 *
 * Regression guard for the 2026-07-04 console privacy leak: the shared turn
 * core narrated every turn (context sources, model text, receipt — including
 * private memory names) to the server console, and the launchd-managed server
 * persisted it to disk. The leak survived every diff-scoped review because it
 * emerged from the composition of changes; this test guards the invariant
 * behaviorally instead: run a REAL turn through the REAL server path with a
 * canary private memory injected, capture everything the server writes to the
 * console, and assert the canary (and the turn content) never appears there.
 *
 * Real dependencies, per the repo testing posture: hits the live Dolt
 * sql-server at 127.0.0.1:3306 (canary rows are inserted and removed around
 * the test) and stands up a loopback stub that speaks the OpenAI-compatible
 * chat/completions wire as the "model". Console capture hooks console.*,
 * which is the channel the original leak used.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { serveWorkbenchUnix, type WorkbenchUnixServer } from "./uds-server";
import { connectUnixClient } from "./uds-client";
import { doltExec } from "./utils";

const MEMORY_SLUG = "canary_leak_test_cf9a";
const MEMORY_NAME = "CANARY-MEMORY-NAME-cf9a";
const MEMORY_CONTENT = "CANARY-MEMORY-CONTENT-cf9a private and load-bearing";
const MODEL_SLUG = "canary-stub-model-cf9a";
const STUB_REPLY = "CANARY-STUB-REPLY-cf9a the turn text itself";

function sseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** Loopback stub speaking the OpenAI-compatible chat/completions wire. */
function startStubModelServer(): { port: number; close(): Promise<void> } {
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (request) => {
      const body = await request.json() as { stream?: boolean };
      if (body.stream) {
        const frames = [
          sseChunk({ choices: [{ delta: { content: STUB_REPLY } }] }),
          sseChunk({
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 7, completion_tokens: 9 },
          }),
          "data: [DONE]\n\n",
        ].join("");
        return new Response(frames, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return Response.json({
        choices: [{
          message: { content: STUB_REPLY },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 7, completion_tokens: 9 },
      });
    },
  );
  return {
    port: (server.addr as Deno.NetAddr).port,
    close: () => server.shutdown(),
  };
}

describe("server console canary (integration)", () => {
  let stub: { port: number; close(): Promise<void> };
  let server: WorkbenchUnixServer;
  let socketDir: string;

  beforeAll(async () => {
    stub = startStubModelServer();
    await doltExec(
      "INSERT INTO memories (memory_id, slug, type, visibility, inject, name, description, content) " +
        "VALUES (?, ?, 'user', 'private', 'always', ?, 'canary row for the console leak test', ?)",
      [`mem_${MEMORY_SLUG}`, MEMORY_SLUG, MEMORY_NAME, MEMORY_CONTENT],
    );
    await doltExec(
      "INSERT INTO models (slug, display_name, provider, api, base_url, tier, " +
        "context_window, max_output_tokens, cost_input, cost_output, " +
        "cost_cache_read, cost_cache_write, reasoning, capabilities, active) " +
        "VALUES (?, 'Canary Stub', 'mlx-lm', 'openai-completions', ?, 0, " +
        "8192, 1024, 0, 0, 0, 0, FALSE, ?, TRUE)",
      [MODEL_SLUG, `http://127.0.0.1:${stub.port}/v1`, '["text"]'],
    );
    socketDir = await Deno.makeTempDir();
    server = await serveWorkbenchUnix(`${socketDir}/wb.sock`, {});
  });

  afterAll(async () => {
    await server?.close();
    await stub?.close();
    await doltExec("DELETE FROM memories WHERE slug = ?", [MEMORY_SLUG]);
    await doltExec("DELETE FROM models WHERE slug = ?", [MODEL_SLUG]);
    try {
      await Deno.remove(socketDir, { recursive: true });
    } catch {
      // already gone
    }
  });

  test("a real turn writes no private context or content to the console", async () => {
    const captured: string[] = [];
    const original = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
    };
    const record =
      (level: keyof typeof original) => (...parts: unknown[]) => {
        captured.push(`${level}: ${parts.map(String).join(" ")}`);
      };
    console.log = record("log");
    console.info = record("info");
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
      console.warn = original.warn;
      console.error = original.error;
    }

    // The turn really ran end to end through the stub model.
    expect(result.text).toContain(STUB_REPLY);

    const consoleOutput = captured.join("\n");
    // The operational summary line is the only expected turn output.
    expect(consoleOutput).toMatch(/\[turn\] session=/);
    // The canary must never reach the server console: not the private memory
    // name, not its content, not the model's response text.
    expect(consoleOutput).not.toContain(MEMORY_NAME);
    expect(consoleOutput).not.toContain(MEMORY_CONTENT);
    expect(consoleOutput).not.toContain(STUB_REPLY);
    // Nor any memory-index narration of the receipt.
    expect(consoleOutput).not.toContain("memory-index:");
  }, 60_000);
});
