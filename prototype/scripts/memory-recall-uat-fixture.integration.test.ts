import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import process from "node:process";
import type { Readable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { composeRuntimePolicy } from "../src/config/mod.ts";
import { buildMemorySearch } from "../src/tools/mod.ts";
import { settleFixtureShutdown } from "./memory-recall-uat-fixture.ts";

async function firstLine(stream: Readable, timeoutMs = 5_000): Promise<string> {
  let buffered = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onData = (_chunk: Buffer) => {};
  let onEnd = () => {};
  try {
    return await new Promise<string>((resolve, reject) => {
      onData = (chunk) => {
        buffered += chunk.toString("utf8");
        const newline = buffered.indexOf("\n");
        if (newline >= 0) resolve(buffered.slice(0, newline));
      };
      onEnd = () =>
        reject(new Error("fixture exited before announcing its URL"));
      stream.on("data", onData);
      stream.once("end", onEnd);
      timer = setTimeout(
        () => reject(new Error("fixture startup exceeded its finite bound")),
        timeoutMs,
      );
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    stream.off("data", onData);
    stream.off("end", onEnd);
  }
}

test("the executable UAT fixture serves strict modern recall", async () => {
  const script = fileURLToPath(
    new URL("./memory-recall-uat-fixture.ts", import.meta.url),
  );
  const child = spawn(process.execPath, [script, "--port", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit") as Promise<
    [number | null, NodeJS.Signals | null]
  >;

  try {
    const announced = await firstLine(child.stdout);
    const url = announced.match(/http:\/\/127\.0\.0\.1:\d+\/mcp/)?.[0];
    assert.ok(url !== undefined, "fixture did not announce a loopback MCP URL");

    const diagnostics: unknown[] = [];
    const recall = buildMemorySearch(
      { url, tool: "fixture-search" },
      (diagnostic) => diagnostics.push(diagnostic),
      // The engine admits the configured endpoint the same way.
      composeRuntimePolicy({ memoryMcpUrl: url }),
    );
    assert.strictEqual(await recall("synthetic UAT query"), "fixture-result");
    assert.deepStrictEqual(diagnostics, [{
      era: "modern",
      revision: "2026-07-28",
      server: { name: "dyfj-memory-recall-uat", version: "1.0.0" },
      extensions: ["dyfj.uat"],
    }]);
  } finally {
    child.kill("SIGTERM");
    const [code] = await exited;
    // Release both pipes: stdout past the announced URL and the unread stderr.
    child.stdout.destroy();
    child.stderr.destroy();
    assert.strictEqual(code, 0, "fixture did not shut down cleanly");
  }
});

test("fixture shutdown settles both resources when one rejects", async () => {
  let httpSettled = false;
  let mcpSettled = false;
  const clean = await settleFixtureShutdown(
    () => {
      httpSettled = true;
      return Promise.reject(new Error("fixture HTTP close failure"));
    },
    () => {
      mcpSettled = true;
      return Promise.resolve();
    },
  );
  assert.ok(httpSettled, "HTTP shutdown was not attempted");
  assert.ok(mcpSettled, "MCP shutdown was not attempted");
  assert.ok(!clean, "a rejected shutdown was reported as clean");
});
