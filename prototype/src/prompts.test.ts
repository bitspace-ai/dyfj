import { describe, expect, test, vi } from "vitest";

vi.mock("./utils", () => ({
  doltQuery: (...args: unknown[]) => mockDoltQuery(...args),
}));

let mockDoltQuery: (...args: unknown[]) => Promise<Array<Record<string, unknown>>>;

const { loadCompanionBasePrompt, DEFAULT_COMPANION_PROMPT } = await import(
  "./prompts"
);

describe("loadCompanionBasePrompt", () => {
  test("returns the active prompt content from the store", async () => {
    mockDoltQuery = async () => [{ content: "Stored companion prompt." }];
    expect(await loadCompanionBasePrompt()).toBe("Stored companion prompt.");
  });

  test("falls back to the default when the store is empty", async () => {
    mockDoltQuery = async () => [];
    expect(await loadCompanionBasePrompt()).toBe(DEFAULT_COMPANION_PROMPT);
  });

  test("falls back to the default when the row content is blank", async () => {
    mockDoltQuery = async () => [{ content: "   " }];
    expect(await loadCompanionBasePrompt()).toBe(DEFAULT_COMPANION_PROMPT);
  });

  test("falls back to the default when the store throws", async () => {
    mockDoltQuery = () => Promise.reject(new Error("dolt unreachable"));
    expect(await loadCompanionBasePrompt()).toBe(DEFAULT_COMPANION_PROMPT);
  });

  test("the default is a non-empty, non-scoping capable-companion frame", () => {
    expect(DEFAULT_COMPANION_PROMPT.length).toBeGreaterThan(0);
    expect(DEFAULT_COMPANION_PROMPT).toContain("capable");
    // No scope-fence language that would make a model refuse off-repo work.
    expect(DEFAULT_COMPANION_PROMPT.toLowerCase()).not.toContain("repo-local");
    expect(DEFAULT_COMPANION_PROMPT.toLowerCase()).not.toContain("do not");
  });
});
