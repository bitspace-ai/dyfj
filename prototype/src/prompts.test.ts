import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  DEFAULT_COMPANION_PROMPT,
  loadCompanionBasePrompt,
} from "./prompts.ts";
import { MemoryStore, type PromptReader } from "./store/mod.ts";

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

Deno.test("loadCompanionBasePrompt returns the active prompt content from the store", async () => {
  assertEquals(
    await loadCompanionBasePrompt(storeWith("Stored companion prompt.")),
    "Stored companion prompt.",
  );
});

Deno.test("loadCompanionBasePrompt falls back to the default when the store has no active row", async () => {
  assertEquals(
    await loadCompanionBasePrompt(new MemoryStore().prompts),
    DEFAULT_COMPANION_PROMPT,
  );
  assertEquals(
    await loadCompanionBasePrompt(storeWith("inactive", false)),
    DEFAULT_COMPANION_PROMPT,
  );
});

Deno.test("loadCompanionBasePrompt falls back to the default when the row content is blank", async () => {
  assertEquals(
    await loadCompanionBasePrompt(storeWith("   ")),
    DEFAULT_COMPANION_PROMPT,
  );
});

Deno.test("loadCompanionBasePrompt falls back to the default when the store throws", async () => {
  const unreachable: PromptReader = {
    active: () => Promise.reject(new Error("dolt unreachable")),
  };
  assertEquals(
    await loadCompanionBasePrompt(unreachable),
    DEFAULT_COMPANION_PROMPT,
  );
});

Deno.test("the default is a non-empty, non-scoping capable-companion frame", () => {
  assert(DEFAULT_COMPANION_PROMPT.length > 0);
  assert(DEFAULT_COMPANION_PROMPT.includes("capable"));
  // No scope-fence language that would make a model refuse off-repo work.
  assertFalse(DEFAULT_COMPANION_PROMPT.toLowerCase().includes("repo-local"));
  assertFalse(DEFAULT_COMPANION_PROMPT.toLowerCase().includes("do not"));
});
