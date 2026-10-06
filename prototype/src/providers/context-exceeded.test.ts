// Every adapter turns a provider's "request larger than the context window"
// rejection into the typed ProviderContextExceededError, and leaves every
// other HTTP failure as the generic error it was.

import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { MapEnv } from "../../testing/fakes/map-env.ts";
import { ScriptedHttpTransport } from "../../testing/fakes/scripted-http-transport.ts";
import {
  ProviderContextExceededError,
  runWorkbenchTurn,
  type WorkbenchModel,
} from "./mod.ts";

const local: WorkbenchModel = {
  slug: "local-test",
  displayName: "Local test",
  provider: "llama-cpp",
  api: "openai-completions",
  baseUrl: "http://localhost:8080/v1",
  tier: 0,
  costInput: 0,
  costOutput: 0,
  capabilities: ["text"],
  contextWindow: 32_768,
};
const anthropic: WorkbenchModel = {
  slug: "anthropic-test",
  displayName: "Anthropic test",
  provider: "anthropic",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  tier: 2,
  costInput: 3,
  costOutput: 15,
  capabilities: ["text"],
};
const gemini: WorkbenchModel = {
  slug: "gemini-test",
  displayName: "Gemini test",
  provider: "google",
  api: "google-generative-ai",
  baseUrl: "https://generativelanguage.googleapis.com",
  tier: 2,
  costInput: 2,
  costOutput: 12,
  capabilities: ["text"],
};
const models = [local, anthropic, gemini];
const env = new MapEnv({
  ANTHROPIC_API_KEY: "test-key-not-real",
  GEMINI_API_KEY: "test-key-not-real",
});
const getEnv = (name: string) => env.get(name);

function turn(model: WorkbenchModel, transport: ScriptedHttpTransport) {
  return runWorkbenchTurn({
    systemPrompt: "system",
    prompt: "hello",
    routing: { modelId: model.slug },
    models,
    getEnv,
    fetchFn: transport.fetch,
  });
}

const CASES: ReadonlyArray<
  { model: WorkbenchModel; status: number; body: string }
> = [
  {
    model: local,
    status: 400,
    body: JSON.stringify({
      error: {
        code: 400,
        message: "request (82366 tokens) exceeds the available context " +
          "size (32768 tokens), try increasing it",
        type: "exceed_context_size_error",
      },
    }),
  },
  {
    model: anthropic,
    status: 400,
    body: JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "prompt is too long: 82366 tokens > 32768 maximum",
      },
    }),
  },
  {
    model: gemini,
    status: 400,
    body: JSON.stringify({
      error: {
        code: 400,
        message: "The input token count (82366) exceeds the maximum " +
          "number of tokens allowed (32768).",
        status: "INVALID_ARGUMENT",
      },
    }),
  },
];

describe("provider context-size rejections", () => {
  for (const { model, status, body } of CASES) {
    it(`${model.provider}: an HTTP ${status} context rejection is typed, with the provider's counts`, async () => {
      const transport = new ScriptedHttpTransport([{
        respond: { status, body },
      }]);
      const error = await assertRejects(
        () => turn(model, transport),
        ProviderContextExceededError,
      );
      assertEquals(error.report, {
        requestedTokens: 82366,
        limitTokens: 32768,
      });
      assertStrictEquals(error.status, status);
      assertStrictEquals(error.slug, model.slug);
      // The message names the counts, never the body.
      assertStrictEquals(error.message.includes("try increasing"), false);
      assertStrictEquals(error.message.includes("82366"), true);
      transport.assertDone();
    });

    it(`${model.provider}: any other HTTP failure stays the generic error`, async () => {
      const transport = new ScriptedHttpTransport([{
        respond: { status: 400, body: '{"error":{"message":"bad model"}}' },
      }]);
      const error = await assertRejects(() => turn(model, transport), Error);
      assertStrictEquals(error instanceof ProviderContextExceededError, false);
      assertStrictEquals(error.message.includes("HTTP 400"), true);
    });
  }
});
