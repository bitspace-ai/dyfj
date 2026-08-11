import { buildMemorySearch } from "../src/memory-search.ts";
import { settleFixtureShutdown } from "./memory-recall-uat-fixture.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function firstLine(
  stream: ReadableStream<Uint8Array>,
  timeoutMs = 5_000,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        while (true) {
          const { value, done } = await reader.read();
          if (done) throw new Error("fixture exited before announcing its URL");
          buffered += decoder.decode(value, { stream: true });
          const newline = buffered.indexOf("\n");
          if (newline >= 0) return buffered.slice(0, newline);
        }
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("fixture startup exceeded its finite bound")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    reader.releaseLock();
  }
}

Deno.test("the executable UAT fixture serves strict modern recall", async () => {
  const script = new URL("./memory-recall-uat-fixture.ts", import.meta.url);
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-prompt",
      "--allow-net=127.0.0.1",
      script.pathname,
      "--port",
      "0",
    ],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  try {
    const announced = await firstLine(child.stdout);
    const url = announced.match(/http:\/\/127\.0\.0\.1:\d+\/mcp/)?.[0];
    assert(url !== undefined, "fixture did not announce a loopback MCP URL");

    const diagnostics: unknown[] = [];
    const recall = buildMemorySearch(
      { url, tool: "fixture-search" },
      (diagnostic) => diagnostics.push(diagnostic),
    );
    assert(
      await recall("synthetic UAT query") === "fixture-result",
      "fixture returned an unexpected result",
    );
    assert(
      JSON.stringify(diagnostics) === JSON.stringify([{
        era: "modern",
        revision: "2026-07-28",
        server: { name: "dyfj-memory-recall-uat", version: "1.0.0" },
        extensions: ["dyfj.uat"],
      }]),
      "fixture emitted unexpected negotiation evidence",
    );
  } finally {
    try {
      child.kill("SIGTERM");
    } catch {
      // The status assertion below reports an early fixture exit.
    }
    const status = await child.status;
    assert(status.success, "fixture did not shut down cleanly");
  }
});

Deno.test("fixture shutdown settles both resources when one rejects", async () => {
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
  assert(httpSettled, "HTTP shutdown was not attempted");
  assert(mcpSettled, "MCP shutdown was not attempted");
  assert(!clean, "a rejected shutdown was reported as clean");
});
