import assert from "node:assert/strict";
import { test } from "node:test";
import { ScriptedHttpTransport } from "../../testing/fakes/scripted-http-transport.ts";
import { composeRuntimePolicy, guardedFetch } from "../config/mod.ts";
import {
  ProviderFailureError,
  runWorkbenchTurn,
  type WorkbenchModel,
} from "./mod.ts";

function localModel(baseUrl: string): WorkbenchModel {
  return {
    slug: "ollama-model",
    displayName: "ollama",
    provider: "ollama",
    api: "openai-completions",
    baseUrl,
    tier: 0,
    costInput: 0,
    costOutput: 0,
    capabilities: ["text"],
  };
}

test("the default provider transport refuses a local server outside the network policy", async () => {
  // Port 1 passes the local base-URL check but is not a policy entry.
  const outside = localModel("http://127.0.0.1:1/v1");
  await assert.rejects(
    () =>
      runWorkbenchTurn({
        systemPrompt: "system",
        prompt: "hello",
        routing: { modelId: outside.slug },
        models: [outside],
      }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderFailureError);
      assert.strictEqual(error.kind, "egress_refused");
      assert.match(error.message, /network egress to "127\.0\.0\.1:1" refused/);
      assert.match(error.message, /\[network\] allow/);
      return true;
    },
  );
});

test("a guarded provider transport passes an allowed host through to the delegate", async () => {
  const scripted = new ScriptedHttpTransport([{
    respond: {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    },
  }]);
  const allowed = localModel("http://127.0.0.1:11434/v1");
  const result = await runWorkbenchTurn({
    systemPrompt: "system",
    prompt: "hello",
    routing: { modelId: allowed.slug },
    models: [allowed],
    fetchFn: guardedFetch(composeRuntimePolicy(), scripted.fetchLike),
  });
  assert.strictEqual(result.text, "hi");
  assert.strictEqual(scripted.requests.length, 1);
});

test("a guarded provider transport refuses before the delegate sees the request", async () => {
  const scripted = new ScriptedHttpTransport();
  const outside = localModel("http://127.0.0.1:1234/v1");
  await assert.rejects(
    () =>
      runWorkbenchTurn({
        systemPrompt: "system",
        prompt: "hello",
        routing: { modelId: outside.slug },
        models: [outside],
        fetchFn: guardedFetch(composeRuntimePolicy(), scripted.fetchLike),
      }),
    (error: unknown) =>
      error instanceof ProviderFailureError &&
      error.kind === "egress_refused",
  );
  assert.strictEqual(scripted.requests.length, 0);
});
