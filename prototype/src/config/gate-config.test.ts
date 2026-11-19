import assert from "node:assert/strict";
import { it } from "node:test";
import { MapEnv } from "../../testing/fakes/map-env.ts";

it("gate config: absent section or command disables the tools", async () => {
  const { parseGateConfig } = await import("./gate-config.ts");
  for (const table of [null, {}, { gate: {} }, { gate: { files_command: ["node", "--test"] } }]) {
    assert.equal(parseGateConfig(table, "config.toml"), null);
  }
});

it("gate config: command alone declares only full with the default deadline", async () => {
  const { parseGateConfig } = await import("./gate-config.ts");
  assert.deepEqual(parseGateConfig({ gate: { command: ["npm", "test"] } }, "config.toml"), {
    commands: { full: ["npm", "test"] }, timeoutSeconds: 1800,
  });
});

it("gate config: files and fast argv and an explicit deadline are preserved", async () => {
  const { parseGateConfig } = await import("./gate-config.ts");
  assert.deepEqual(parseGateConfig({ gate: {
    command: ["npm", "test"], files_command: ["node", "--test"], fast_command: ["npm", "run", "test:fast"], timeout_seconds: 12,
  } }, "config.toml"), {
    commands: { full: ["npm", "test"], files: ["node", "--test"], fast: ["npm", "run", "test:fast"] }, timeoutSeconds: 12,
  });
});

it("gate config: malformed keys fail loading and name the key", async () => {
  const { loadGateConfig } = await import("./gate-config.ts");
  const invalid = [
    ["command", "npm test"], ["command", []], ["command", [""]],
    ["command", ["npm", 1]], ["command", ["npm", "test\0"]],
    ["files_command", "node --test"], ["files_command", []],
    ["fast_command", "npm run test:fast"], ["fast_command", []],
    ["fast_command", [""]], ["fast_command", ["npm", 1]], ["fast_command", ["npm", "test\0"]],
    ["timeout_seconds", 0], ["timeout_seconds", 1.5],
    ["timeout_seconds", "1800"], ["timeout_seconds", 2147484],
    ["unexpected", true],
  ] as const;
  for (const [key, value] of invalid) {
    await assert.rejects(loadGateConfig({
      env: new MapEnv({ HOME: "/fixture" }),
      readTextFile: async () => "fixture",
      parseToml: () => ({ gate: { command: ["npm", "test"], [key]: value } }),
    }), new RegExp(`gate\\.${key}`));
  }
  await assert.rejects(loadGateConfig({
    readTextFile: async () => "fixture", parseToml: () => ({ gate: [] }),
  }), /\[gate\]/);
});
