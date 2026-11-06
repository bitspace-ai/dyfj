// Tests for the shared model-catalog loader (`model-catalog.ts`): the rows
// `workbench.models` receives carry only the fields it shows, and a catalog
// failure falls back to the built-in local rows without passing the reason on.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkbenchModel } from "../providers/mod.ts";
import type { ModelReader } from "../store/mod.ts";
import { MAX_LISTED_MODELS } from "../tools/mod.ts";
import {
  catalogListing,
  catalogModelRow,
  loadModelCatalog,
} from "./model-catalog.ts";

const HOSTED: WorkbenchModel = {
  slug: "hosted-large",
  displayName: "Hosted Large",
  provider: "anthropic",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.invalid/v1",
  tier: 2,
  costInput: 3,
  costOutput: 15,
  capabilities: ["text"],
};

test("a tool row keeps only the fields the tool shows", () => {
  const row = catalogModelRow(HOSTED);
  assert.deepStrictEqual(Object.keys(row).sort(), [
    "costInput",
    "costOutput",
    "displayName",
    "local",
    "modality",
    "provider",
    "routable",
    "slug",
    "tier",
  ]);
  assert.strictEqual(row.routable, true);
  assert.strictEqual(row.local, false);
  assert.ok(!JSON.stringify(row).includes("api.anthropic.invalid"));
});

test("a catalog failure lists the built-in local rows and keeps the reason off the listing", async () => {
  const failing = (): ModelReader => {
    throw new Error("store detail that must not reach the model");
  };
  const catalog = await loadModelCatalog(failing);
  assert.ok(catalog.models.length > 0);
  assert.ok(catalog.models.every((m) => m.tier === 0));
  assert.strictEqual(typeof catalog.unavailable, "string");
  const listing = catalogListing(catalog);
  assert.strictEqual(listing.fallback, true);
  assert.ok(!JSON.stringify(listing).includes("store detail"));
});

test("a loaded catalog is not marked as the fallback", () => {
  assert.strictEqual(catalogListing({ models: [HOSTED] }).fallback, undefined);
});

test("only the rows the tool prints are projected, with the catalog's count", () => {
  const models = Array.from(
    { length: MAX_LISTED_MODELS + 5 },
    (_, i) => ({ ...HOSTED, slug: `m${i}` }),
  );
  const listing = catalogListing({ models });
  assert.strictEqual(listing.models.length, MAX_LISTED_MODELS);
  assert.strictEqual(listing.total, MAX_LISTED_MODELS + 5);
});
