// The real command loop through the executor (BIT-735). Started by
// `dyfj-sandbox serve` as the runtime, it drives the product's own bash tool,
// which hands each command to the executor because the supervisor set
// DYFJ_EXECUTOR_SOCKET. The runtime makes a harmless edit itself, as its file
// tools would; the executor runs the tests and makes a local commit. It then
// times warm dispatch. Synthetic content only.
//
//   node loop-probe.ts            the edit, test and commit loop
//   node loop-probe.ts executor   the executor-side probes, printed
//   node loop-probe.ts hold       one long command, for the lease test
import { writeFileSync } from "node:fs";
import process from "node:process";
import { defineBash } from "../../src/tools/builtin/exec.ts";

const ROOT = "/work";
const bash = defineBash(ROOT);
const context = { authzBasis: "policy:allow:operator-approved" };

async function run(command: string, timeoutSec = 120): Promise<string> {
  return await bash.executor(
    {
      commandId: "bash",
      callId: `l8-${Date.now()}`,
      caller: { principalId: "operator", principalType: "human" },
      arguments: { command, timeoutSec },
    },
    context,
  ) as string;
}

function line(step: string, output: string) {
  process.stdout.write(`${JSON.stringify({ step, output })}\n`);
}

const mode = process.argv[2] ?? "loop";

if (mode === "hold") {
  line("hold", await run("sleep 300", 600));
} else if (mode === "executor") {
  line("executor probes", await run(String(process.argv[3])));
} else {
  line("init", await run(
    "git init -q -b main && git config user.email l8@example.invalid && git config user.name 'L8 acceptance' && echo initialized",
  ));
  writeFileSync(
    `${ROOT}/greeting.mjs`,
    "export const greeting = (name) => `hello, ${name}`;\n",
  );
  writeFileSync(
    `${ROOT}/greeting.test.mjs`,
    [
      'import assert from "node:assert/strict";',
      'import { test } from "node:test";',
      'import { greeting } from "./greeting.mjs";',
      'test("greets", () => assert.equal(greeting("l8"), "hello, l8"));',
      "",
    ].join("\n"),
  );
  line("harmless edit by the runtime", "wrote greeting.mjs and greeting.test.mjs");
  line("whoami in the executor", await run("id -un 2>/dev/null || id -u"));
  line("tests in the executor", await run("node --test greeting.test.mjs 2>&1 | grep -E '(pass|fail) [0-9]+$' | tr -d 'ℹ#'"));
  line("local commit in the executor", await run(
    "git add greeting.mjs greeting.test.mjs && git commit -qm 'L8: harmless edit' && git log --oneline -1",
  ));

  const samples: number[] = [];
  for (let i = 0; i < 20; i++) {
    const started = performance.now();
    await run("true");
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  line(
    "warm dispatch, 20 runs (ms)",
    `min ${samples[0]!.toFixed(1)} median ${samples[10]!.toFixed(1)} max ${samples[19]!.toFixed(1)}`,
  );
}
