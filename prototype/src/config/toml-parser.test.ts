// Parity between the two TOML parsers over every TOML shape the repository
// reads: the example config, the README examples (copied into fixtures, since
// unit tests read only this package), the MCP adapter fixtures and the golden
// suite's friction config. smol-toml returns null-prototype tables and
// @std/toml plain ones; no config reader depends on the prototype, so tables
// are rebuilt as plain objects before the deep comparison. Removed with
// @std/toml; the fixtures stay as smol-toml golden cases.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse as parseStd } from "@std/toml";
import { parse as parseSmol } from "smol-toml";
import { frictionConfig } from "../../testing/golden/harness.ts";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
const fixture = (name: string) => read(`../../testing/fixtures/toml/${name}`);

const CASES: Record<string, () => Promise<string>> = {
  "config-example": () => read("../../config.example.toml"),
  "readme-secrets": () => fixture("readme-secrets.toml"),
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
// so a Date (a TOML datetime) still compares as a Date.
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

for (const [name, load] of Object.entries(CASES)) {
  test(`TOML parity: ${name} parses identically under both parsers`, async () => {
    const raw = await load();
    assert.deepStrictEqual(plain(parseSmol(raw)), plain(parseStd(raw)));
  });
}
