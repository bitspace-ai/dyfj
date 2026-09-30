// ACP client cases that need no child process, environment or socket: the
// prompt deadline, the ingress guard, stream draining, usage parsing and the
// pre-spawn profile checks. The cases that start the fixture agent live in
// acp-client.integration.test.ts.
import {
  assertEquals,
  assertObjectMatch,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Readable } from "node:stream";
import {
  type AcpExecutionProfile,
  ActivePromptDeadline,
  drainStream,
  guardedProtocolInput,
  processGroupSignalerEvalArgs,
  processGroupSignalerEvalSource,
  resolveProtocolMessageLimit,
  resolveSessionUpdateLimit,
  runAcpAgent,
  settleDrain,
  tokenUsageFromPromptResponse,
  usageSnapshotFromUpdate,
} from "./acp-client.ts";

/**
 * A well-formed profile that is never spawned: every case here either reads
 * it or is refused before a child would start. The unit lane grants no run
 * permission, so an unexpected spawn fails the case instead of passing it.
 */
function staticProfile(
  overrides: Partial<AcpExecutionProfile> = {},
): AcpExecutionProfile {
  return {
    slug: "fixture",
    command: "/nonexistent/dyfj-acp-fixture",
    args: [],
    environment: { ACP_FIXTURE_ALLOWED: "yes" },
    workspace: "/nonexistent/workspace",
    transport: "local_stdio",
    accessRoute: "local_sidecar",
    costBasis: "local_free",
    initializeTimeoutMs: 2_000,
    sessionTimeoutMs: 2_000,
    promptTimeoutMs: 2_000,
    cancellationTimeoutMs: 500,
    terminationTimeoutMs: 500,
    ...overrides,
  };
}

describe("ActivePromptDeadline", () => {
  it("excludes operator deliberation from active prompt execution", () => {
    let now = 0;
    const deadline = new ActivePromptDeadline(30, () => now);
    now = 10;
    deadline.pause();
    now = 1_000;
    assertStrictEquals(deadline.remainingMs, 20);
    deadline.resume();
    now = 1_019;
    assertStrictEquals(deadline.remainingMs, 1);
  });

  it("resumes with the remaining budget instead of resetting it", () => {
    let now = 0;
    const deadline = new ActivePromptDeadline(100, () => now);
    now = 40;
    deadline.pause();
    now = 1_000;
    deadline.resume();
    now = 1_060;
    assertStrictEquals(deadline.remainingMs, 0);
  });

  it("does not pause after the prompt budget has expired", () => {
    let now = 0;
    const deadline = new ActivePromptDeadline(30, () => now);
    now = 31;
    deadline.pause();
    assertStrictEquals(deadline.isPaused, false);
    assertStrictEquals(deadline.remainingMs, 0);
  });

  it("does not double-count an overlapping paused interval", () => {
    let now = 0;
    const deadline = new ActivePromptDeadline(100, () => now);
    now = 10;
    deadline.pause();
    now = 1_000;
    deadline.pause();
    now = 2_000;
    assertStrictEquals(deadline.remainingMs, 90);
    deadline.resume();
    now = 2_090;
    assertStrictEquals(deadline.remainingMs, 0);
  });
});

describe("guardedProtocolInput", () => {
  function agentMessageChunkLine(text: string): Uint8Array {
    return new TextEncoder().encode(`${
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fixture-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          },
        },
      })
    }\n`);
  }

  function thoughtChunkLine(): Uint8Array {
    return new TextEncoder().encode(`${
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fixture-1",
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "" },
          },
        },
      })
    }\n`);
  }

  function concatBytes(parts: Uint8Array[]): Uint8Array {
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    return out;
  }

  async function runGuardedExchanges(
    exchanges: Uint8Array[],
    resetBetween = true,
  ): Promise<Uint8Array> {
    const source = new TransformStream<Uint8Array, Uint8Array>();
    const writer = source.writable.getWriter();
    const { stream, resetExchange } = guardedProtocolInput(
      source.readable,
      () => "fixture-1",
      () => {},
    );
    const chunks: Uint8Array[] = [];
    const reading = stream.pipeTo(
      new WritableStream({
        write(chunk) {
          chunks.push(chunk);
        },
      }),
    );
    try {
      for (let index = 0; index < exchanges.length; index++) {
        if (index > 0 && resetBetween) resetExchange();
        const chunk = exchanges[index];
        if (chunk === undefined) continue;
        await writer.write(chunk);
      }
      await writer.close();
      await reading;
    } catch (error) {
      await writer.abort().catch(() => {});
      try {
        await reading;
      } catch (readError) {
        throw readError;
      }
      throw error;
    }
    return concatBytes(chunks);
  }

  it("resets the agent-response budget at each exchange", async () => {
    const first = agentMessageChunkLine("x".repeat(50_000));
    const second = agentMessageChunkLine("x".repeat(50_000));
    const output = await runGuardedExchanges([first, second]);
    assertEquals(output, concatBytes([first, second]));
  });

  it("keeps a lifetime budget without an exchange reset", async () => {
    const first = agentMessageChunkLine("x".repeat(50_000));
    const second = agentMessageChunkLine("x".repeat(50_000));
    await assertRejects(
      () => runGuardedExchanges([first, second], false),
      Error,
      "ACP agent response exceeded the text limit",
    );
  });

  it("still fails closed when a single exchange exceeds 60KB", async () => {
    await assertRejects(
      () => runGuardedExchanges([agentMessageChunkLine("x".repeat(60_001))]),
      Error,
      "ACP agent response exceeded the text limit",
    );
  });

  it("resets the session-update budget at each exchange", async () => {
    const line = thoughtChunkLine();
    const first = concatBytes(Array.from({ length: 1_024 }, () => line));
    const second = concatBytes(Array.from({ length: 1_024 }, () => line));
    const output = await runGuardedExchanges([first, second]);
    assertEquals(output, concatBytes([first, second]));
  });
});

describe("runAcpAgent", () => {
  it("process-group signaler eval carries only the probe source", () => {
    const source = processGroupSignalerEvalSource();
    assertStrictEquals(source.includes(";void "), false);
    assertEquals(processGroupSignalerEvalArgs(), ["eval", source]);
  });

  it("cancels a stderr drain whose producer never closes", async () => {
    const stream = new Readable({ read() {} });
    const drain = drainStream(stream);
    await drain.cancel();
    await drain.done;
    assertStrictEquals(stream.destroyed, true);
    // A late pipe error after the drain settled must not throw.
    stream.emit("error", new Error("late pipe error"));
  });

  it("cancels a stderr drain when cleanup reaches its deadline", async () => {
    const stream = new Readable({ read() {} });
    const drain = drainStream(stream);
    await settleDrain(drain, 1);
    assertStrictEquals(stream.destroyed, true);
    await drain.done;
  });

  it("bounds discarded stream bytes", async () => {
    const stream = Readable.from([
      new Uint8Array(8),
      new Uint8Array(8),
    ]);
    const drain = drainStream(stream, 10);
    await drain.done;
    assertStrictEquals(stream.destroyed, true);
  });

  it("drops malformed optional ACP usage without inventing accounting", () => {
    assertStrictEquals(
      tokenUsageFromPromptResponse({
        totalTokens: 3,
        inputTokens: -1,
        outputTokens: 2,
      }),
      undefined,
    );
    assertStrictEquals(
      usageSnapshotFromUpdate({
        sessionUpdate: "usage_update",
        used: 9,
        size: 8,
        cost: { amount: 1, currency: "USD" },
      }),
      undefined,
    );
    assertEquals(
      usageSnapshotFromUpdate({
        sessionUpdate: "usage_update",
        used: 4,
        size: 8,
        cost: { amount: 1, currency: "usd" },
      }),
      { used: 4, size: 8 },
    );
  });

  it("does not dispatch a prompt for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    assertObjectMatch(
      await runAcpAgent({
        profile: staticProfile(),
        prompt: "FIXTURE_CANCEL",
        abortSignal: controller.signal,
      }),
      {
        text: "",
        stopReason: "aborted",
      },
    );
  });

  it("resolves protocol-message ceilings from the execution profile", () => {
    assertStrictEquals(resolveProtocolMessageLimit(staticProfile()), 393_216);
    assertStrictEquals(
      resolveProtocolMessageLimit(staticProfile({
        protocolMessagePolicy: "long_running",
      })),
      1_048_576,
    );
  });

  it("rejects an invalid protocol-message policy before spawning", async () => {
    await assertRejects(
      () =>
        runAcpAgent({
          profile: {
            ...staticProfile(),
            protocolMessagePolicy: "invalid",
          } as unknown as AcpExecutionProfile,
          prompt: "unused",
        }),
      Error,
      "ACP profile has an invalid protocol-message policy",
    );
  });

  it("the ingress guard rejects update floods independently of the SDK consumer", async () => {
    const payload = new TextEncoder().encode(`${
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fixture-1",
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "" },
          },
        },
      })
    }\n`);
    let sent = 0;
    const { stream: guarded } = guardedProtocolInput(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent < 1_025) {
            sent += 1;
            controller.enqueue(payload);
          } else {
            controller.close();
          }
        },
      }),
      () => "fixture-1",
      () => {},
    );
    await assertRejects(
      () => guarded.pipeTo(new WritableStream()),
      Error,
      "ACP agent exceeded the session-update limit",
    );
  });

  it("the ingress guard enforces the resolved long-running allowance", async () => {
    const payload = new TextEncoder().encode(`${
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fixture-1",
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "" },
          },
        },
      })
    }\n`);
    const profile = staticProfile({ sessionUpdatePolicy: "long_running" });
    const limit = resolveSessionUpdateLimit(profile);
    let sent = 0;
    const { stream: guarded } = guardedProtocolInput(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent <= limit) {
            sent += 1;
            controller.enqueue(payload);
          } else {
            controller.close();
          }
        },
      }),
      () => "fixture-1",
      () => {},
      limit,
    );
    await assertRejects(
      () => guarded.pipeTo(new WritableStream()),
      Error,
      "ACP agent exceeded the session-update limit",
    );
    assertStrictEquals(limit, 8_192);
  });

  it("accepts a valid protocol line fragmented into one-byte chunks", async () => {
    const payload = new TextEncoder().encode(`${
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fixture-1",
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "x".repeat(16_384) },
          },
        },
      })
    }\n`);
    const { stream: guarded } = guardedProtocolInput(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const byte of payload) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        },
      }),
      () => "fixture-1",
      () => {},
    );
    assertEquals(
      new Uint8Array(await new Response(guarded).arrayBuffer()),
      payload,
    );
  });

  it("rejects Windows absolute paths on non-Windows hosts", async () => {
    if (Deno.build.os === "windows") return;
    await assertRejects(
      () =>
        runAcpAgent({
          profile: staticProfile({
            command: "C:\\missing\\acp-agent.exe",
            workspace: "C:\\workspace",
          }),
          prompt: "unused",
        }),
      Error,
      "ACP profile command must be absolute",
    );
  });
});
