// The committed `deno.json` task strings and permission sets of the generic
// server and login tasks. Reads files only, so it runs in the unit lane; the
// cases that run the task strings through `/bin/sh` are in
// `deno-tasks.integration.test.ts`.
import {
  assertArrayIncludes,
  assertFalse,
  assertMatch,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";

describe("runtime lifecycle commands", () => {
  it("generic server tasks remain cross-platform and runner-neutral", async () => {
    const raw = await Deno.readTextFile("deno.json");
    const parsed = JSON.parse(raw) as {
      tasks: Record<string, string>;
      permissions: Record<string, {
        env?: string[] | boolean;
        read?: string[] | boolean;
        run?: string[] | boolean;
        sys?: string[] | boolean;
      }>;
    };
    const tasks = parsed.tasks;
    assertStringIncludes(
      tasks["codex-chatgpt-login"],
      '--allow-read=".,$node_path,$HOME,$HOME/.dyfj,$HOME/.dyfj/runner-homes,$HOME/.dyfj/runner-homes/codex-chatgpt"',
    );
    assertStringIncludes(
      tasks["codex-chatgpt-login"],
      '--allow-write="$HOME/.dyfj,$HOME/.dyfj/runner-homes,$HOME/.dyfj/runner-homes/codex-chatgpt"',
    );
    assertStringIncludes(
      tasks["codex-chatgpt-login"],
      '--allow-run="bash,$node_path"',
    );
    assertStringIncludes(tasks["codex-chatgpt-login"], "--allow-sys=uid");
    assertMatch(tasks["serve-unix"], /^deno run --no-prompt /);
    assertFalse(tasks["serve-unix"].includes("/bin/sh"));
    assertFalse(tasks["serve-unix"].includes("DYFJ_NODE_PATH"));
    assertArrayIncludes(parsed.permissions["serve-unix"].run as string[], [
      "/bin/kill",
    ]);
    assertArrayIncludes(parsed.permissions["serve-unix"].sys as string[], [
      "uid",
    ]);
    assertArrayIncludes(parsed.permissions["test"].run as string[], [
      "/bin/bash",
    ]);
    const vitestRunner = await Deno.readTextFile("scripts/run-vitest.ts");
    assertStringIncludes(vitestRunner, "const run = [");
    assertStringIncludes(vitestRunner, "denoExecutable,");
    assertStringIncludes(vitestRunner, "`--allow-run=${run}`");
    assertFalse(
      vitestRunner.includes(
        "--allow-run=bash,/bin/bash,deno,/bin/kill,/bin/sh",
      ),
    );
    assertArrayIncludes(parsed.permissions["serve-unix"].env as string[], [
      "NODE_V8_COVERAGE",
    ]);
    assertStrictEquals(parsed.permissions["serve-unix"].read, true);
  });
});
