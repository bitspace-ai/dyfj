import { assertEquals, assertStrictEquals } from "@std/assert";
import { MapEnv } from "../../testing/fakes/map-env.ts";
import { envFileVar, readLauncherEnvVar } from "./env-file.ts";

// Pins the dotenv subset the launcher reads so it resolves the same value the
// spawned runtime reads through `--env-file=.env`.

Deno.test("envFileVar reads KEY=VALUE, export prefix, quotes and comments", () => {
  const text = [
    "# comment",
    "",
    "OTHER=1",
    'export DYFJ_MEMORY_MCP_URL="https://memory.example/mcp"',
    "SINGLE='x'",
    "  SPACED  =  padded value  ",
  ].join("\n");
  assertEquals(
    envFileVar(text, "DYFJ_MEMORY_MCP_URL"),
    "https://memory.example/mcp",
  );
  assertEquals(envFileVar(text, "OTHER"), "1");
  assertEquals(envFileVar(text, "SINGLE"), "x");
  assertEquals(envFileVar(text, "SPACED"), "padded value");
  assertStrictEquals(envFileVar(text, "MISSING"), undefined);
});

Deno.test("envFileVar: first definition wins, empty values are defined", () => {
  assertEquals(envFileVar("A=first\nA=second\n", "A"), "first");
  assertStrictEquals(envFileVar("A=\n", "A"), "");
  assertStrictEquals(envFileVar('A=""\n', "A"), "");
});

Deno.test("envFileVar keeps '=' inside values and unmatched quotes verbatim", () => {
  assertEquals(envFileVar("A=b=c\n", "A"), "b=c");
  assertEquals(envFileVar('A="open\n', "A"), '"open');
  assertEquals(envFileVar("A='mixed\"\n", "A"), "'mixed\"");
});

Deno.test("envFileVar ignores commented and malformed lines", () => {
  assertStrictEquals(envFileVar("# A=1\n", "A"), undefined);
  assertStrictEquals(envFileVar("1A=1\n", "1A"), undefined);
  assertStrictEquals(envFileVar("A 1\n", "A"), undefined);
});

// Precedence mirrors the child: `--env-file` never overrides a variable that
// is already defined in the ambient environment, even when it is empty.

Deno.test("readLauncherEnvVar: a defined ambient value wins over .env", async () => {
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
  assertEquals(value, "/ambient");
  assertEquals(reads, []);
});

Deno.test("readLauncherEnvVar: an empty ambient value is authoritative", async () => {
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
  assertStrictEquals(value, "");
  assertEquals(reads, []);
});

Deno.test("readLauncherEnvVar: unset ambient falls back to <cwd>/.env", async () => {
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
  assertEquals(value, "/from-file");
  assertEquals(reads, ["/proto/.env"]);
});

Deno.test("readLauncherEnvVar: an unreadable .env yields undefined", async () => {
  const value = await readLauncherEnvVar(
    "/proto",
    "DYFJ_ROOT",
    () => Promise.reject(new Deno.errors.NotFound()),
    new MapEnv(),
  );
  assertStrictEquals(value, undefined);
});
