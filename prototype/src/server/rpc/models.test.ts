import { assertEquals } from "@std/assert";
import type { WorkbenchModel } from "../../providers/mod.ts";
import { callRpc } from "../../../testing/builders/rpc.ts";
import { buildModelsHandlers } from "./models.ts";

async function listModels(rows: unknown[]) {
  const { models } = await callRpc(
    buildModelsHandlers({
      loadModels: () => Promise.resolve(rows as WorkbenchModel[]),
    }),
    "models/list",
  ) as { models: Array<Record<string, unknown>> };
  return models;
}

Deno.test("models/list returns the loaded models with a server-computed routable flag", async () => {
  const models = await listModels([
    { slug: "local-x", tier: 0, costInput: 0, costOutput: 0 },
    { slug: "hosted-priced", tier: 2, costInput: 15, costOutput: 75 },
    { slug: "hosted-unpriced", tier: 2, costInput: 0, costOutput: 0 },
  ]);
  assertEquals(models.map((m) => [m.slug, m.routable]), [
    ["local-x", true],
    ["hosted-priced", true],
    ["hosted-unpriced", false],
  ]);
});

Deno.test("models/list marks locality server-side", async () => {
  const models = await listModels([
    {
      slug: "local-x",
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      tier: 0,
      costInput: 0,
      costOutput: 0,
    },
    {
      slug: "hosted-x",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      tier: 2,
      costInput: 15,
      costOutput: 75,
    },
  ]);
  assertEquals(models.map((m) => [m.slug, m.local]), [
    ["local-x", true],
    ["hosted-x", false],
  ]);
});

Deno.test("models/list marks access modality server-side", async () => {
  const models = await listModels([
    {
      slug: "local-x",
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      tier: 0,
      costInput: 0,
      costOutput: 0,
    },
    {
      slug: "router-x",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      tier: 1,
      costInput: 0.1,
      costOutput: 0.2,
    },
    {
      slug: "frontier-x",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      tier: 2,
      costInput: 15,
      costOutput: 75,
    },
  ]);
  assertEquals(models.map((m) => [m.slug, m.modality]), [
    ["local-x", "local"],
    ["router-x", "aggregator-hosted"],
    ["frontier-x", "frontier-hosted"],
  ]);
});
