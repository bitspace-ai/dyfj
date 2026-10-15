import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_COMPANION_PROMPT,
  loadCompanionBasePrompt,
} from "./prompts.ts";
import { MemoryStore, type PromptReader } from "../store/mod.ts";

const storeWith = (content: string, active = true) =>
  new MemoryStore({
    prompts: [{
      slug: "companion-base",
      display_name: "Companion",
      kind: "base",
      content,
      active,
    }],
  }).prompts;

test("loadCompanionBasePrompt returns the active prompt content from the store", async () => {
  assert.deepStrictEqual(
    await loadCompanionBasePrompt(storeWith("Stored companion prompt.")),
    "Stored companion prompt.",
  );
});

test("loadCompanionBasePrompt falls back to the default when the store has no active row", async () => {
  assert.deepStrictEqual(
    await loadCompanionBasePrompt(new MemoryStore().prompts),
    DEFAULT_COMPANION_PROMPT,
  );
  assert.deepStrictEqual(
    await loadCompanionBasePrompt(storeWith("inactive", false)),
    DEFAULT_COMPANION_PROMPT,
  );
});

test("loadCompanionBasePrompt falls back to the default when the row content is blank", async () => {
  assert.deepStrictEqual(
    await loadCompanionBasePrompt(storeWith("   ")),
    DEFAULT_COMPANION_PROMPT,
  );
});

test("loadCompanionBasePrompt falls back to the default when the store throws", async () => {
  const unreachable: PromptReader = {
    active: () => Promise.reject(new Error("dolt unreachable")),
  };
  assert.deepStrictEqual(
    await loadCompanionBasePrompt(unreachable),
    DEFAULT_COMPANION_PROMPT,
  );
});

test("the default is a non-empty, non-scoping capable-companion frame", () => {
  assert.ok(DEFAULT_COMPANION_PROMPT.length > 0);
  assert.ok(DEFAULT_COMPANION_PROMPT.includes("capable"));
  // No scope-fence language that would make a model refuse off-repo work.
  assert.ok(!DEFAULT_COMPANION_PROMPT.toLowerCase().includes("repo-local"));
  assert.ok(!DEFAULT_COMPANION_PROMPT.toLowerCase().includes("do not"));
});
