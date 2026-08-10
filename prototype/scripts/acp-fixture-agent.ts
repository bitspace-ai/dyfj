import {
  agent,
  type AgentContext,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";

const pidFile = Deno.args.find((arg) => arg.startsWith("--pid-file="))?.slice(
  "--pid-file=".length,
);
if (pidFile !== undefined) await Deno.writeTextFile(pidFile, String(Deno.pid));
const grandchildPidFile = Deno.args.find((arg) =>
  arg.startsWith("--grandchild-pid-file=")
)?.slice("--grandchild-pid-file=".length);

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
      const pid = Number(await Deno.readTextFile(path));
      if (Number.isSafeInteger(pid) && pid > 0) return;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("fixture descendant readiness timed out");
}

const app = agent({ name: "dyfj-acp-fixture" })
  .onRequest(methods.agent.initialize, async () => {
    if (Deno.env.get("ACP_FIXTURE_MODE") === "initialize_mute") {
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
    authenticationStatusRead = true;
    switch (Deno.env.get("ACP_FIXTURE_AUTH_STATUS")) {
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
    if (
      Deno.env.get("ACP_FIXTURE_AUTH_STATUS") === "chat-gpt" &&
      !authenticationStatusRead
    ) {
      throw new Error("session/new preceded authentication/status");
    }
    if (Deno.env.get("ACP_FIXTURE_MODE") === "session_new_mute") {
      await new Promise(() => {});
    }
    if (Deno.env.get("ACP_FIXTURE_MODE") === "session_new_early_update") {
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
    if (Deno.env.get("ACP_FIXTURE_MODE") === "session_close_mute") {
      await new Promise(() => {});
    }
    if (Deno.env.get("ACP_FIXTURE_MODE") === "late_permission_during_close") {
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
      const fixture = sessions.get(params.sessionId);
      if (fixture === undefined) throw new Error("unknown fixture session");
      const prompt = params.prompt
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      if (
        prompt.includes("FIXTURE_STUBBORN_DESCENDANT") &&
        grandchildPidFile !== undefined
      ) {
        try {
          const grandchild = new Deno.Command("bash", {
            args: [
              "-c",
              'trap "" TERM; echo "$$" > "$1"; while :; do sleep 1; done',
              "bash",
              grandchildPidFile,
            ],
            stdin: "null",
            stdout: "null",
            stderr: "null",
          }).spawn();
          grandchild.unref();
          await waitForRecordedPid(grandchildPidFile);
        } catch (error) {
          await chunk(
            context,
            params.sessionId,
            `fixture descendant spawn failed: ${String(error)}`,
          );
          return { stopReason: "end_turn" };
        }
      }
      if (prompt.includes("FIXTURE_EARLY_EXIT")) Deno.exit(17);
      if (prompt.includes("FIXTURE_MUTE")) await new Promise(() => {});
      if (prompt.includes("FIXTURE_ENV")) {
        const blocked = [
          "ANTHROPIC_API_KEY",
          "DOLT_PASSWORD",
          "DYFJ_MEMORY_MCP_TOKEN",
          "SSH_AUTH_SOCK",
        ].map((name) => `${name}=${Deno.env.get(name) ?? "missing"}`).join(";");
        await chunk(
          context,
          params.sessionId,
          `allowed=${Deno.env.get("ACP_FIXTURE_ALLOWED") ?? "missing"};` +
            `ambient=${
              Deno.env.get("ACP_FIXTURE_AMBIENT_VALUE") ?? "missing"
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
        await Deno.stdout.write(
          new TextEncoder().encode("{malformed fixture json\n"),
        );
        await new Promise(() => {});
      }
      if (prompt.includes("FIXTURE_INVALID_UTF8")) {
        const encoder = new TextEncoder();
        await Deno.stdout.write(encoder.encode(
          '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"fixture-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"',
        ));
        await Deno.stdout.write(Uint8Array.of(0xFF));
        await Deno.stdout.write(encoder.encode('"}}}}\n'));
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
            options: duplicateIds
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
  ndJsonStream(Deno.stdout.writable, Deno.stdin.readable),
);
await connection.closed;
