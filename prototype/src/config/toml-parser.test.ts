// Golden cases for the TOML parser over every TOML shape the repository
// reads: the example config, the README examples (copied into fixtures, since
// unit tests read only this package), the MCP adapter fixtures and the golden
// suite's friction config. The expected values were recorded when smol-toml
// became the parser, after it and the previous parser agreed on every case.
// smol-toml returns null-prototype tables; no config reader depends on the
// prototype, so tables are rebuilt as plain objects before the comparison.
// The README secrets example is checked structurally instead of against a
// recorded value: its pointer placeholders, written out as recorded JSON, trip
// the secret-shape guard on commit. The parity run covered it under both
// parsers before the switch.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { defaultParseToml } from "./toml.ts";
import { frictionConfig } from "../../testing/golden/harness.ts";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
const fixture = (name: string) => read(`../../testing/fixtures/toml/${name}`);

const CASES: Record<string, () => Promise<string>> = {
  "config-example": () => read("../../config.example.toml"),
  "readme-mcp-records": () => fixture("readme-mcp-records.toml"),
  "readme-mcp-linear-binding": () => fixture("readme-mcp-linear-binding.toml"),
  "readme-mcp-web": () => fixture("readme-mcp-web.toml"),
  "mcp-adapter-documented": () => fixture("mcp-adapter-documented.toml"),
  "mcp-adapter-linear-binding": () =>
    fixture("mcp-adapter-linear-binding.toml"),
  "golden-friction": () =>
    Promise.resolve(frictionConfig("http://127.0.0.1:1/mcp")),
};

// Rebuilds every table as a plain object, leaving every other value as is,
// so a Date (a TOML datetime) would not compare equal to its JSON string.
function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plain);
  if (
    typeof value === "object" && value !== null && !(value instanceof Date)
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, plain(entry)]),
    );
  }
  return value;
}

test("every TOML golden case has an expected value, and no more", async () => {
  const expected = JSON.parse(await fixture("expected.json"));
  assert.deepStrictEqual(
    Object.keys(expected).sort(),
    Object.keys(CASES).sort(),
  );
});

for (const [name, load] of Object.entries(CASES)) {
  test(`TOML golden: ${name} parses to its recorded value`, async () => {
    const expected = JSON.parse(await fixture("expected.json"))[name];
    assert.deepStrictEqual(
      plain(await defaultParseToml(await load())),
      expected,
    );
  });
}

test("TOML golden: readme-secrets parses to the documented pointer table", async () => {
  const parsed = plain(
    await defaultParseToml(await fixture("readme-secrets.toml")),
  ) as { secrets: Record<string, unknown> };
  assert.deepStrictEqual(Object.keys(parsed), ["secrets"]);
  const { pointers, ...rest } = parsed.secrets;
  assert.deepStrictEqual(rest, { command: ["op", "read"], timeout_ms: 10000 });
  const table = pointers as Record<string, unknown>;
  assert.deepStrictEqual(Object.keys(table).sort(), [
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "XAI_API_KEY",
  ]);
  // The README's placeholder shape, never a real pointer.
  const placeholder = /^op:\/\/<vault>\/<item>\/credential$/;
  for (const value of Object.values(table)) {
    assert.equal(typeof value, "string");
    assert.match(value as string, placeholder);
  }
});
