import {
  agent,
  type AgentContext,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { Readable, Writable } from "node:stream";

// Written to `node:` builtins only, so the same script runs under either
// runtime: the fixture profile starts it on whichever one runs the product
// (`fixtureAgentCommand` in `src/acp-fixture-command.ts`).

const args = process.argv.slice(2);
const pidFile = args.find((arg) => arg.startsWith("--pid-file="))?.slice(
  "--pid-file=".length,
);
if (pidFile !== undefined) await writeFile(pidFile, String(process.pid));
const grandchildPidFile = args.find((arg) =>
  arg.startsWith("--grandchild-pid-file=")
)?.slice("--grandchild-pid-file=".length);
const methodLogFile = args.find((arg) => arg.startsWith("--method-log="))
  ?.slice("--method-log=".length);

async function logMethod(method: string): Promise<void> {
  if (methodLogFile === undefined) return;
  await appendFile(methodLogFile, `${method}\n`);
}

const originParent = process.ppid;
void (async () => {
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (process.ppid === 1 || process.ppid !== originParent) {
      // Reap the process group this agent leads with a signal, not a
      // `/bin/kill` process: a runtime or permission model that grants no
      // spawn cannot refuse it. SIGKILL ends this agent too.
      try {
        process.kill(-process.pid, "SIGKILL");
      } catch {
        // Not a group leader, or the group is already gone.
      }
      process.exit(1);
    }
  }
})();

const sessions = new Map<
  string,
  { cwd: string; cancel: PromiseWithResolvers<void>; cancelled: boolean }
>();
let nextSession = 1;
let authenticationStatusRead = false;

const emptyParams = (params: unknown): Record<string, never> => {
  if (
    typeof params !== "object" || params === null || Array.isArray(params) ||
    Object.keys(params).length !== 0
  ) {
    throw new Error("expected empty object params");
  }
  return {};
};

/** Writes raw bytes past the protocol stream, as the malformed cases need. */
function writeStdout(bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) =>
    process.stdout.write(bytes, (error) => error ? reject(error) : resolve())
  );
}

async function chunk(
  context: AgentContext,
  sessionId: string,
  text: string,
): Promise<void> {
  await context.notify(methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    },
  });
}

async function waitForRecordedPid(path: string): Promise<void> {
  const deadline = performance.now() + 1_000;
  while (performance.now() < deadline) {
    try {
      const pid = Number(await readFile(path, "utf8"));
      if (Number.isSafeInteger(pid) && pid > 0) return;
    } catch (error) {
      if ((error as { code?: unknown }).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("fixture descendant readiness timed out");
}

const app = agent({ name: "dyfj-acp-fixture" })
  .onRequest(methods.agent.initialize, async () => {
    await logMethod("initialize");
    if (process.env.ACP_FIXTURE_MODE === "initialize_mute") {
      await new Promise(() => {});
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        promptCapabilities: {},
        sessionCapabilities: { close: {} },
      },
      agentInfo: { name: "dyfj-acp-fixture", version: "1.0.0" },
    };
  })
  .onRequest("authentication/status", emptyParams, () => {
    void logMethod("authentication/status");
    authenticationStatusRead = true;
    switch (process.env.ACP_FIXTURE_AUTH_STATUS) {
      case "mute":
        return new Promise(() => {});
      case "chat-gpt":
        return { type: "chat-gpt", email: "fixture@example.invalid" };
      case "api-key":
        return { type: "api-key" };
      case "gateway":
        return { type: "gateway", name: "fixture" };
      case "unauthenticated":
        return { type: "unauthenticated" };
      case "malformed":
        return {};
      default:
        throw new Error("authentication/status unavailable");
    }
  })
  .onRequest(methods.agent.session.new, async ({ params, client: context }) => {
    await logMethod("session/new");
    if (
      process.env.ACP_FIXTURE_AUTH_STATUS === "chat-gpt" &&
      !authenticationStatusRead
    ) {
      throw new Error("session/new preceded authentication/status");
    }
    if (process.env.ACP_FIXTURE_MODE === "session_new_mute") {
      await new Promise(() => {});
    }
    if (process.env.ACP_FIXTURE_MODE === "session_new_early_update") {
      await context.notify(methods.client.session.update, {
        sessionId: "bogus-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "must-not-arrive" },
        },
      });
    }
    const sessionId = `fixture-${nextSession++}`;
    sessions.set(sessionId, {
      cwd: params.cwd,
      cancel: Promise.withResolvers<void>(),
      cancelled: false,
    });
    return { sessionId };
  })
  .onRequest(methods.agent.session.close, async ({ params }) => {
    await logMethod("session/close");
    if (process.env.ACP_FIXTURE_MODE === "session_close_mute") {
      await new Promise(() => {});
    }
    if (process.env.ACP_FIXTURE_MODE === "late_permission_during_close") {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    sessions.delete(params.sessionId);
    return {};
  })
  .onNotification(methods.agent.session.cancel, ({ params }) => {
    const session = sessions.get(params.sessionId);
    if (session === undefined) return;
    session.cancelled = true;
    session.cancel.resolve();
  })
  .onRequest(
    methods.agent.session.prompt,
    async ({ params, client: context }) => {
      await logMethod("session/prompt");
      const fixture = sessions.get(params.sessionId);
      if (fixture === undefined) throw new Error("unknown fixture session");
      const prompt = params.prompt
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      if (prompt.includes("FIXTURE_USAGE")) {
        await context.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "usage_update",
            used: 1_250,
            size: 8_192,
            cost: { amount: 0.42, currency: "USD" },
          },
        });
        await chunk(context, params.sessionId, "usage reported");
        return {
          stopReason: "end_turn",
          usage: {
            totalTokens: 1_250,
            inputTokens: 1_000,
            outputTokens: 200,
            thoughtTokens: 50,
            cachedReadTokens: 400,
          },
        };
      }
      if (
        prompt.includes("FIXTURE_STUBBORN_DESCENDANT") &&
        grandchildPidFile !== undefined
      ) {
        try {
          // An empty environment, as for `/bin/kill` above: with no PATH,
          // the default search path finds `bash` and the `sleep` it runs.
          const grandchild = spawn("bash", [
            "-c",
            'trap "" TERM; echo "$$" > "$1"; while :; do sleep 1; done',
            "bash",
            grandchildPidFile,
          ], { env: {}, stdio: "ignore" });
          grandchild.unref();
          await new Promise<void>((resolve, reject) => {
            grandchild.once("error", reject);
            waitForRecordedPid(grandchildPidFile).then(resolve, reject);
          });
        } catch (error) {
          await chunk(
            context,
            params.sessionId,
            `fixture descendant spawn failed: ${String(error)}`,
          );
          return { stopReason: "end_turn" };
        }
      }
      if (prompt.includes("FIXTURE_EARLY_EXIT")) process.exit(17);
      if (prompt.includes("FIXTURE_MUTE")) await new Promise(() => {});
      if (prompt.includes("FIXTURE_ENV")) {
        const blocked = [
          "ANTHROPIC_API_KEY",
          "DOLT_PASSWORD",
          "DYFJ_MEMORY_MCP_TOKEN",
          "SSH_AUTH_SOCK",
        ].map((name) => `${name}=${process.env[name] ?? "missing"}`).join(";");
        await chunk(
          context,
          params.sessionId,
          `allowed=${process.env.ACP_FIXTURE_ALLOWED ?? "missing"};` +
            `ambient=${
              process.env.ACP_FIXTURE_AMBIENT_VALUE ?? "missing"
            };${blocked}`,
        );
        return { stopReason: "end_turn" };
      }
      if (prompt.includes("FIXTURE_CANCEL")) {
        await chunk(context, params.sessionId, "partial\n");
        if (prompt.includes("FIXTURE_CANCEL_IGNORED")) {
          await new Promise(() => {});
        }
        await fixture.cancel.promise;
        return { stopReason: "cancelled" };
      }
      if (prompt.includes("FIXTURE_CROSS_SESSION")) {
        await context.notify(methods.client.session.update, {
          sessionId: `${params.sessionId}-other`,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "must-not-cross" },
          },
        });
        await new Promise(() => {});
      }
      if (prompt.includes("FIXTURE_MALFORMED")) {
        await writeStdout(
          new TextEncoder().encode("{malformed fixture json\n"),
        );
        await new Promise(() => {});
      }
      if (prompt.includes("FIXTURE_INVALID_UTF8")) {
        const encoder = new TextEncoder();
        await writeStdout(encoder.encode(
          '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"fixture-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"',
        ));
        await writeStdout(Uint8Array.of(0xFF));
        await writeStdout(encoder.encode('"}}}}\n'));
        await new Promise(() => {});
      }
      if (prompt.includes("FIXTURE_PERMISSION")) {
        const hostile = prompt.includes("FIXTURE_PERMISSION_HOSTILE");
        const allowOnly = prompt.includes("FIXTURE_PERMISSION_ALLOW_ONLY");
        const lateReject = prompt.includes("FIXTURE_PERMISSION_LATE_REJECT");
        const rejectOnly = prompt.includes("FIXTURE_PERMISSION_REJECT_ONLY");
        const overlapping = prompt.includes("FIXTURE_PERMISSION_OVERLAP");
        const duplicateIds = prompt.includes(
          "FIXTURE_PERMISSION_DUPLICATE_IDS",
        );
        const emptyAllowId = prompt.includes(
          "FIXTURE_PERMISSION_EMPTY_ALLOW_ID",
        );
        const overLimitDuplicate = prompt.includes(
          "FIXTURE_PERMISSION_OVER_LIMIT_DUPLICATE",
        );
        const scopeProbe = prompt.includes("FIXTURE_PERMISSION_SCOPE");
        const permissionResponse = context.request(
          methods.client.session.requestPermission,
          {
            sessionId: params.sessionId,
            toolCall: {
              toolCallId: hostile ? "fixture-tool\u001b[31m" : "fixture-tool",
              title: hostile
                ? `Write fixture\u001b[31m${"x".repeat(512)}`
                : "Write fixture file",
              name: "write_file",
              kind: "edit",
              status: "pending",
              rawInput: { path: "fixture.txt", content: "fixture" },
            },
            options: overLimitDuplicate
              ? Array.from({ length: 17 }, () => ({
                optionId: "duplicate",
                name: "Allow once",
                kind: "allow_once" as const,
              }))
              : emptyAllowId
              ? [{
                optionId: "",
                name: "Allow once",
                kind: "allow_once" as const,
              }]
              : duplicateIds
              ? [
                {
                  optionId: "ambiguous",
                  name: "Allow once",
                  kind: "allow_once" as const,
                },
                {
                  optionId: "ambiguous",
                  name: "Reject once",
                  kind: "reject_once" as const,
                },
              ]
              : rejectOnly
              ? [{
                optionId: "reject",
                name: "Reject once",
                kind: "reject_once" as const,
              }]
              : lateReject
              ? [
                ...Array.from({ length: 16 }, (_, index) => ({
                  optionId: `allow-${index}`,
                  name: `Allow ${index}`,
                  kind: "allow_once" as const,
                })),
                {
                  optionId: "reject-late",
                  name: "Reject once",
                  kind: "reject_once" as const,
                },
              ]
              : scopeProbe
              ? [
                {
                  optionId: "allow-always",
                  name: "Allow always",
                  kind: "allow_always" as const,
                },
                {
                  optionId: "allow-once",
                  name: "Allow once",
                  kind: "allow_once" as const,
                },
                {
                  optionId: "reject-always",
                  name: "Reject always",
                  kind: "reject_always" as const,
                },
                {
                  optionId: "reject-once",
                  name: "Reject once",
                  kind: "reject_once" as const,
                },
              ]
              : [
                {
                  optionId: "allow",
                  name: hostile
                    ? `Allow\u001b[31m${"x".repeat(256)}`
                    : "Allow once",
                  kind: "allow_once",
                },
                ...(allowOnly ? [] : [{
                  optionId: "deny",
                  name: "Reject once",
                  kind: "reject_once" as const,
                }]),
              ],
          },
        );
        const permissionResponses = [permissionResponse];
        if (overlapping) {
          permissionResponses.push(context.request(
            methods.client.session.requestPermission,
            {
              sessionId: params.sessionId,
              toolCall: {
                toolCallId: "fixture-tool-overlap",
                title: "Write overlapping fixture file",
                name: "write_file",
                kind: "edit",
                status: "pending",
                rawInput: { path: "fixture-overlap.txt", content: "fixture" },
              },
              options: [{
                optionId: "allow",
                name: "Allow once",
                kind: "allow_once",
              }, {
                optionId: "deny",
                name: "Reject once",
                kind: "reject_once",
              }],
            },
          ));
        }
        if (prompt.includes("FIXTURE_PERMISSION_EARLY_TERMINAL")) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          void permissionResponse.catch(() => {});
          return { stopReason: "end_turn" };
        }
        const responses = await Promise.all(permissionResponses);
        const response = responses[0];
        if (prompt.includes("FIXTURE_PERMISSION_EXPECT_CANCEL")) {
          await fixture.cancel.promise;
          return { stopReason: "cancelled" };
        }
        if (scopeProbe || lateReject || rejectOnly) {
          if (fixture.cancelled) return { stopReason: "cancelled" };
          await chunk(
            context,
            params.sessionId,
            response.outcome.outcome === "selected"
              ? response.outcome.optionId
              : "cancelled",
          );
          return { stopReason: "end_turn" };
        }
        if (fixture.cancelled) return { stopReason: "cancelled" };
        const verdict = responses.every((response) =>
            response.outcome.outcome === "selected" &&
            response.outcome.optionId === "allow"
          )
          ? "approved"
          : "denied";
        await chunk(context, params.sessionId, verdict);
        return { stopReason: "end_turn" };
      }
      if (prompt.includes("FIXTURE_LATE_PERMISSION")) {
        setTimeout(() => {
          void context.request(methods.client.session.requestPermission, {
            sessionId: params.sessionId,
            toolCall: {
              toolCallId: "late-tool",
              title: "Late fixture action",
              name: "write_file",
              kind: "edit",
              status: "pending",
              rawInput: { path: "late.txt" },
            },
            options: [{
              optionId: "allow",
              name: "Allow once",
              kind: "allow_once",
            }],
          }).catch(() => {});
        }, 10);
        return { stopReason: "end_turn" };
      }
      if (prompt.includes("FIXTURE_NEAR_LIMIT_RESPONSE")) {
        await chunk(context, params.sessionId, "x".repeat(50_000));
        return { stopReason: "end_turn" };
      }
      if (prompt.includes("FIXTURE_OVERSIZED_RESPONSE")) {
        await chunk(context, params.sessionId, "x".repeat(60_001));
        return { stopReason: "end_turn" };
      }
      if (prompt.includes("FIXTURE_LONG_PROTOCOL_MESSAGE_FLOOD")) {
        await context.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "x".repeat(1_100_000) },
          },
        });
        return { stopReason: "end_turn" };
      }
      if (prompt.includes("FIXTURE_LARGE_PROTOCOL_MESSAGE")) {
        await context.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "x".repeat(450_000) },
          },
        });
        await chunk(context, params.sessionId, "complete");
        return { stopReason: "end_turn" };
      }
      if (prompt.includes("FIXTURE_LONG_UPDATE_STREAM")) {
        for (let index = 0; index < 1_025; index++) {
          await chunk(context, params.sessionId, "");
        }
        await chunk(context, params.sessionId, "complete");
        return { stopReason: "end_turn" };
      }
      if (prompt.includes("FIXTURE_LONG_UPDATE_FLOOD")) {
        for (let index = 0; index < 8_193; index++) {
          await chunk(context, params.sessionId, "");
        }
        return { stopReason: "end_turn" };
      }
      if (prompt.includes("FIXTURE_UPDATE_FLOOD")) {
        for (let index = 0; index < 1_025; index++) {
          await chunk(context, params.sessionId, "");
        }
        return { stopReason: "end_turn" };
      }
      if (prompt.includes("FIXTURE_PROTOCOL_INPUT_FLOOD")) {
        for (let index = 0; index < 65; index++) {
          await context.notify(methods.client.session.update, {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: "x".repeat(260_000) },
            },
          });
        }
        return { stopReason: "end_turn" };
      }
      if (
        prompt.includes("FIXTURE_TOOL_HISTORY_DUPLICATE_ID")
      ) {
        for (let index = 0; index < 2; index++) {
          await context.notify(methods.client.session.update, {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "fixture-duplicate-call",
              title: "Read duplicate fixture",
              kind: "read",
              status: "completed",
              rawInput: { path: "duplicate-fixture.txt" },
              rawOutput: { text: `duplicate-${index}` },
            },
          });
        }
        await chunk(context, params.sessionId, "recorded");
        return { stopReason: "end_turn" };
      }
      if (
        prompt.includes("FIXTURE_TOOL_HISTORY_UNKNOWN_UPDATE")
      ) {
        await context.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "fixture-unknown-call",
            status: "completed",
            rawOutput: { text: "unknown" },
          },
        });
        await chunk(context, params.sessionId, "recorded");
        return { stopReason: "end_turn" };
      }
      if (
        prompt.includes("FIXTURE_TOOL_HISTORY_NONTERMINAL")
      ) {
        await context.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "fixture-nonterminal-call",
            title: "Read nonterminal fixture",
            kind: "read",
            status: "in_progress",
            rawInput: { path: "nonterminal-fixture.txt" },
          },
        });
        await chunk(context, params.sessionId, "recorded");
        return { stopReason: "end_turn" };
      }
      if (
        prompt.includes("FIXTURE_TOOL_HISTORY_INTERRUPTED")
      ) {
        await context.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "fixture-interrupted-call",
            title: "Read interrupted fixture",
            kind: "read",
            status: "in_progress",
            rawInput: { path: "interrupted-fixture.txt" },
          },
        });
        await fixture.cancel.promise;
        return { stopReason: "cancelled" };
      }
      if (
        prompt.includes("FIXTURE_TOOL_HISTORY") &&
        !prompt.includes("FIXTURE_RECALL")
      ) {
        await context.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "fixture-history-call",
            title: "Read fixture history",
            kind: "read",
            status: "in_progress",
            rawInput: { path: "fixture-history.txt" },
          },
        });
        await context.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "fixture-history-call",
            status: "completed",
            rawOutput: { text: "codename=zephyr-quill-7" },
          },
        });
        await chunk(context, params.sessionId, "recorded");
        return { stopReason: "end_turn" };
      }
      if (prompt.includes("FIXTURE_THOUGHT_AND_PROGRESS")) {
        await context.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "pondering problem" },
          },
        });
        await context.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call-1",
            title: "Inspecting codebase",
            name: "grep_search",
            status: "in_progress",
          },
        });
        await chunk(context, params.sessionId, "solution found");
        return { stopReason: "end_turn" };
      }
      if (prompt.includes("FIXTURE_RECALL")) {
        // The fixture agent keeps no memory of its own, so this answer can only
        // come from an antecedent present in the prompt it received — which is
        // what makes it an oracle for reconstructed continuity.
        const codename = /codename=([A-Za-z0-9-]{1,64})/.exec(prompt);
        await chunk(
          context,
          params.sessionId,
          codename === null ? "recalled=none" : `recalled=${codename[1]}`,
        );
        return { stopReason: "end_turn" };
      }
      if (prompt.includes("FIXTURE_MAX_TOKENS")) {
        return { stopReason: "max_tokens" };
      }
      if (prompt.includes("FIXTURE_MAX_TURN_REQUESTS")) {
        return { stopReason: "max_turn_requests" };
      }
      if (prompt.includes("FIXTURE_REFUSAL")) {
        return { stopReason: "refusal" };
      }
      await chunk(context, params.sessionId, "first|");
      await chunk(context, params.sessionId, `cwd=${fixture.cwd}|`);
      await chunk(context, params.sessionId, "last");
      return { stopReason: "end_turn" };
    },
  );

const connection = app.connect(
  ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ),
);
await connection.closed;
