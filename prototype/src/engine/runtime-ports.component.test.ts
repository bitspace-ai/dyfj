/**
 * Component tests for the native runtime's service ports: a whole turn run
 * with an injected `Env`, `Clock` and provider `HttpTransport` must read and
 * call through them. This file runs in the unit lane, which grants no env or
 * net access, so a runtime path that fell back to process state or the
 * platform `fetch` would fail here instead of passing silently.
 */
import { assertEquals, assertObjectMatch } from "@std/assert";
import { stub } from "@std/testing/mock";
import { ManualClock } from "../../testing/fakes/manual-clock.ts";
import { MapEnv } from "../../testing/fakes/map-env.ts";
import {
  type RecordedRequest,
  type ScriptedExchange,
  ScriptedHttpTransport,
} from "../../testing/fakes/scripted-http-transport.ts";
import { CeilingConfirmationStore } from "../budget/mod.ts";
import { MemoryStore, type ModelSeed } from "../store/mod.ts";
import { runWorkbenchRuntime } from "./native-runner.ts";
import { SessionOwners } from "./session-owner.ts";

/**
 * A free hosted row: tier 0 on the Anthropic endpoint, so its adapter needs
 * `ANTHROPIC_API_KEY` from the environment.
 */
const HOSTED_FREE_MODEL: ModelSeed = {
  slug: "hosted-free",
  display_name: "Hosted Free",
  provider: "anthropic",
  api: "anthropic-messages",
  base_url: "https://api.anthropic.com",
  tier: 0,
  context_window: 32_768,
  max_output_tokens: 4_096,
  capabilities: ["text", "code"],
};

/** A non-streaming Anthropic reply that moves the clock while it is served. */
function anthropicReply(
  clock: ManualClock,
  elapsedMs: number,
): ScriptedExchange {
  return {
    respond: () => {
      clock.advance(elapsedMs);
      return new Response(JSON.stringify({
        content: [{ type: "text", text: "hello from the fake" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      }));
    },
  };
}

/** Run one turn against fakes only; returns what crossed the ports. */
async function turnWith(env: Record<string, string>) {
  const clock = new ManualClock({ start: 1_000_000 });
  const store = new MemoryStore({ models: [HOSTED_FREE_MODEL] }, {
    now: clock.date,
  });
  const transport = new ScriptedHttpTransport([anthropicReply(clock, 250)]);
  // The runtime logs its receipt, and the unit lane has no env grant for the
  // principal lookup behind the best-effort model_selected row.
  const log = stub(console, "log");
  const warn = stub(console, "warn");
  try {
    const result = await runWorkbenchRuntime({
      mode: "turn",
      prompt: "hello",
      routingOptions: {},
      defaultCompanionModel: HOSTED_FREE_MODEL.slug,
      log: () => {},
    }, {
      store,
      budgetScopes: new SessionOwners(new CeilingConfirmationStore(clock)),
      clock,
      env: new MapEnv(env),
      http: transport.fetch,
    });
    const rows = await store.events.bySession({
      sessionId: result.sessionId,
      limit: 100,
      order: "asc",
    });
    return { result, rows, requests: transport.requests };
  } finally {
    log.restore();
    warn.restore();
  }
}

function toolNames(request: RecordedRequest): string[] {
  const body = JSON.parse(request.body) as { tools?: { name: string }[] };
  return (body.tools ?? []).map((tool) => tool.name).sort();
}

Deno.test("the injected transport, env and clock carry a whole native turn", async () => {
  const { result, rows, requests } = await turnWith({
    ANTHROPIC_API_KEY: "key-from-the-injected-env",
  });
  assertEquals(result.text, "hello from the fake");
  // The provider call went through the injected transport, authenticated
  // with the credential from the injected env.
  assertEquals(requests.length, 1);
  assertEquals(
    requests[0].headers["x-api-key"],
    "key-from-the-injected-env",
  );
  // Durations come from the injected clock: the reply advanced it 250ms.
  assertObjectMatch(rows.find((row) => row.event_type === "session_end")!, {
    duration_ms: "250",
  });
});

Deno.test("memory recall is configured from the injected env", async () => {
  const credential = { ANTHROPIC_API_KEY: "key" };
  const without = await turnWith(credential);
  const withRecall = await turnWith({
    ...credential,
    DYFJ_MEMORY_MCP_URL: "http://127.0.0.1:9/mcp",
    DYFJ_MEMORY_MCP_TOOL: "fixture-search",
  });
  // Only the env naming a memory service registers the recall tool; nothing
  // is fetched from it, since the model never calls the tool.
  const added = toolNames(withRecall.requests[0]).filter((name) =>
    !toolNames(without.requests[0]).includes(name)
  );
  assertEquals(added.length, 1);
  assertEquals(added[0].includes("memory"), true);
});
