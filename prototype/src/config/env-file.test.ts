import assert from "node:assert/strict";
import { test } from "node:test";
import { MapEnv } from "../../testing/fakes/map-env.ts";
import { envFileVar, readLauncherEnvVar } from "./env-file.ts";

// Pins the dotenv subset the launcher reads so it resolves the same value the
// spawned runtime reads through `--env-file=.env`.

test("envFileVar reads KEY=VALUE, export prefix, quotes and comments", () => {
  const text = [
    "# comment",
    "",
    "OTHER=1",
    'export DYFJ_MEMORY_MCP_URL="https://memory.example/mcp"',
    "SINGLE='x'",
    "  SPACED  =  padded value  ",
  ].join("\n");
  assert.deepStrictEqual(
    envFileVar(text, "DYFJ_MEMORY_MCP_URL"),
    "https://memory.example/mcp",
  );
  assert.deepStrictEqual(envFileVar(text, "OTHER"), "1");
  assert.deepStrictEqual(envFileVar(text, "SINGLE"), "x");
  assert.deepStrictEqual(envFileVar(text, "SPACED"), "padded value");
  assert.strictEqual(envFileVar(text, "MISSING"), undefined);
});

test("envFileVar: first definition wins, empty values are defined", () => {
  assert.deepStrictEqual(envFileVar("A=first\nA=second\n", "A"), "first");
  assert.strictEqual(envFileVar("A=\n", "A"), "");
  assert.strictEqual(envFileVar('A=""\n', "A"), "");
});

test("envFileVar keeps '=' inside values and unmatched quotes verbatim", () => {
  assert.deepStrictEqual(envFileVar("A=b=c\n", "A"), "b=c");
  assert.deepStrictEqual(envFileVar('A="open\n', "A"), '"open');
  assert.deepStrictEqual(envFileVar("A='mixed\"\n", "A"), "'mixed\"");
});

test("envFileVar ignores commented and malformed lines", () => {
  assert.strictEqual(envFileVar("# A=1\n", "A"), undefined);
  assert.strictEqual(envFileVar("1A=1\n", "1A"), undefined);
  assert.strictEqual(envFileVar("A 1\n", "A"), undefined);
});

// Precedence mirrors the child: `--env-file` never overrides a variable that
// is already defined in the ambient environment, even when it is empty.

test("readLauncherEnvVar: a defined ambient value wins over .env", async () => {
  const reads: string[] = [];
  const value = await readLauncherEnvVar(
    "/proto",
    "DYFJ_ROOT",
    (path) => {
      reads.push(path);
      return Promise.resolve("DYFJ_ROOT=/from-file\n");
    },
    new MapEnv({ DYFJ_ROOT: "/ambient" }),
  );
  assert.deepStrictEqual(value, "/ambient");
  assert.deepStrictEqual(reads, []);
});

test("readLauncherEnvVar: an empty ambient value is authoritative", async () => {
  const reads: string[] = [];
  const value = await readLauncherEnvVar(
    "/proto",
    "DYFJ_ROOT",
    (path) => {
      reads.push(path);
      return Promise.resolve("DYFJ_ROOT=/from-file\n");
    },
    new MapEnv({ DYFJ_ROOT: "" }),
  );
  assert.strictEqual(value, "");
  assert.deepStrictEqual(reads, []);
});

test("readLauncherEnvVar: unset ambient falls back to <cwd>/.env", async () => {
  const reads: string[] = [];
  const value = await readLauncherEnvVar(
    "/proto",
    "DYFJ_ROOT",
    (path) => {
      reads.push(path);
      return Promise.resolve("DYFJ_ROOT=/from-file\n");
    },
    new MapEnv(),
  );
  assert.deepStrictEqual(value, "/from-file");
  assert.deepStrictEqual(reads, ["/proto/.env"]);
});

test("readLauncherEnvVar: an unreadable .env yields undefined", async () => {
  const value = await readLauncherEnvVar(
    "/proto",
    "DYFJ_ROOT",
    () =>
      Promise.reject(
        Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }),
      ),
    new MapEnv(),
  );
  assert.strictEqual(value, undefined);
});
