import type { AssistantMessage, Context, ToolCall } from "@mariozechner/pi-ai";
import type { RoutingOptions } from "./router";

export interface WorkbenchReceiptInput {
  sessionId: string;
  traceId: string;
  modelName: string;
  modelSlug: string;
  tier: 0 | 1 | 2;
  routingReason: string;
  totalCostUsd: number;
  totalTokensInput: number;
  totalTokensOutput: number;
  totalCalls: number;
}

export function formatMoney(value: number): string {
  return `$${value.toFixed(6)}`;
}

export function buildWorkbenchReceipt(input: WorkbenchReceiptInput): string {
  return [
    "Workbench receipt",
    `Session: ${input.sessionId}`,
    `Trace:   ${input.traceId}`,
    `Model:   ${input.modelName} (${input.modelSlug}, tier ${input.tier})`,
    `Route:   ${input.routingReason}`,
    `Cost:    ${formatMoney(input.totalCostUsd)}`,
    `Tokens:  ${input.totalTokensInput} in, ${input.totalTokensOutput} out`,
    `Calls:   ${input.totalCalls}`,
  ].join("\n");
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

export async function runWorkbench(args = process.argv.slice(2)): Promise<void> {
  const {
    generateULID,
    generateTraceId,
    generateSpanId,
    extractText,
    extractThinking,
    writeEvent,
    normaliseStopReason,
  } = await import("./utils");
  const { routedStream } = await import("./router");
  const { BudgetTracker } = await import("./budget");
  const {
    loadMemoriesByType,
    loadMemoryIndex,
    buildSystemPrompt,
    buildReadMemoryTool,
    executeReadMemory,
    buildToolResult,
  } = await import("./memory");

  const cliModel = getArg(args, "--model");
  const cliTier = getArg(args, "--tier");
  const cliHint = getArg(args, "--hint") as "code" | "chat" | "reasoning" | undefined;
  const cliPrompt = getArg(args, "--prompt") ?? "What is the next useful DYFJ workbench step?";

  const routingOptions: RoutingOptions = {
    modelId: cliModel,
    hint: cliHint,
    tier: cliTier === undefined ? undefined : Number(cliTier) as 0 | 1 | 2,
  };

  const sessionId = generateULID();
  const traceId = generateTraceId();
  const sessionStart = Date.now();
  const budget = new BudgetTracker(sessionId, traceId);
  const principalId = process.env.DYFJ_PRINCIPAL_ID ?? process.env.USER ?? "user";

  console.log("DYFJ Workbench\n");

  await writeEvent({
    event_id: generateULID(),
    session_id: sessionId,
    event_type: "session_start",
    trace_id: traceId,
    span_id: generateSpanId(),
    principal_id: principalId,
    principal_type: "human",
    action: "start",
    resource: "workbench_session",
    authz_basis: "user_consent",
  });

  console.log("Loading context...");
  const coreMemories = await loadMemoriesByType(["user", "feedback"]);
  const memoryIndex = await loadMemoryIndex(["project", "reference"]);
  console.log(`Loaded ${coreMemories.length} core memories, ${memoryIndex.length} index entries\n`);

  const context: Context = {
    systemPrompt: buildSystemPrompt(coreMemories, memoryIndex),
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: cliPrompt }],
        timestamp: Date.now(),
      },
    ],
    tools: [buildReadMemoryTool()],
  };

  const maxToolTurns = 5;
  let spanId: string | null = null;
  let selectedForReceipt: { displayName: string; slug: string; tier: 0 | 1 | 2 } | null = null;
  let routingReason = "not_selected";

  try {
    for (let turn = 1; turn <= maxToolTurns; turn++) {
      const { stream, selectedModel, selection } = await routedStream(
        context,
        routingOptions,
        sessionId,
        traceId,
        undefined,
        budget,
      );

      selectedForReceipt = {
        displayName: selectedModel.displayName,
        slug: selectedModel.slug,
        tier: selectedModel.tier,
      };
      routingReason = selection.reason;

      if (turn === 1) {
        console.log(`Model:  ${selectedModel.displayName} (tier ${selectedModel.tier})`);
        console.log(`Route:  ${selection.reason}\n`);
      }

      spanId = generateSpanId();
      let assistantMessage: AssistantMessage | null = null;

      for await (const event of stream) {
        if (event.type === "text_delta") {
          process.stdout.write(event.delta);
        }

        if (event.type === "done") {
          if (turn === 1) process.stdout.write("\n");
          assistantMessage = event.message;
          budget.record(event.message.usage, selectedModel.tier);

          await writeEvent({
            event_id: generateULID(),
            session_id: sessionId,
            event_type: "model_response",
            trace_id: traceId,
            span_id: spanId,
            principal_id: principalId,
            principal_type: "agent",
            action: "invoke",
            resource: event.message.model,
            authz_basis: "user_consent",
            model_id: event.message.model,
            provider: event.message.provider,
            api: event.message.api,
            tokens_input: event.message.usage.input,
            tokens_output: event.message.usage.output,
            tokens_cache_read: event.message.usage.cacheRead,
            tokens_cache_write: event.message.usage.cacheWrite,
            cost_total: event.message.usage.cost.total,
            content: extractText(event.message.content),
            stop_reason: normaliseStopReason(event.message.stopReason),
            thinking: extractThinking(event.message.content),
            duration_ms: Date.now() - sessionStart,
          });
        }

        if (event.type === "error") {
          console.error("\nModel error:", event.error.errorMessage ?? "unknown");
          await writeEvent({
            event_id: generateULID(),
            session_id: sessionId,
            event_type: "error",
            trace_id: traceId,
            span_id: spanId,
            principal_id: principalId,
            principal_type: "agent",
            action: "invoke",
            resource: event.error.model ?? "unknown",
            authz_basis: "user_consent",
            model_id: event.error.model,
            provider: event.error.provider,
            api: event.error.api,
            content: event.error.errorMessage,
            stop_reason: event.error.stopReason,
            duration_ms: Date.now() - sessionStart,
          });
          break;
        }
      }

      if (!assistantMessage) break;

      const toolCalls = assistantMessage.content.filter(
        (c): c is ToolCall => c.type === "toolCall",
      );
      if (toolCalls.length === 0) break;

      const toolResults = [];
      for (const tc of toolCalls) {
        if (tc.name !== "read_memory") continue;

        const slug = tc.arguments.slug as string;
        const result = await executeReadMemory(slug);
        const found = !result.startsWith("Memory not found");

        console.log(`read_memory("${slug}") - ${found ? "loaded" : "not found"}`);

        await writeEvent({
          event_id: generateULID(),
          session_id: sessionId,
          event_type: "tool_call",
          trace_id: traceId,
          span_id: generateSpanId(),
          parent_span_id: spanId,
          principal_id: principalId,
          principal_type: "agent",
          action: "tool_call",
          resource: `memory:${slug}`,
          authz_basis: "implicit",
          tool_name: tc.name,
          tool_call_id: tc.id,
          tool_arguments: JSON.stringify(tc.arguments),
          tool_result: result.slice(0, 500),
          tool_is_error: !found,
        });

        toolResults.push(buildToolResult(tc.id, tc.name, result, !found));
      }

      if (toolResults.length === 0) break;
      context.messages.push(assistantMessage, ...toolResults);
    }
  } catch (err: unknown) {
    const name = (err as Error)?.name ?? "Error";
    if (name === "ConsentDeclinedError") {
      console.log("\nConsent declined - no model call made.");
    } else if (name === "BudgetExceededError") {
      console.log(`\nBudget exceeded: ${(err as Error).message}`);
    } else {
      console.error("\nUnexpected error:", err);
    }
  } finally {
    await writeEvent({
      event_id: generateULID(),
      session_id: sessionId,
      event_type: "session_end",
      trace_id: traceId,
      span_id: generateSpanId(),
      principal_id: principalId,
      principal_type: "human",
      action: "end",
      resource: "workbench_session",
      authz_basis: "user_consent",
      duration_ms: Date.now() - sessionStart,
    });

    await budget.writeSummaryEvent();

    const summary = budget.getSummary();
    console.log("");
    console.log(buildWorkbenchReceipt({
      sessionId,
      traceId,
      modelName: selectedForReceipt?.displayName ?? "none",
      modelSlug: selectedForReceipt?.slug ?? "none",
      tier: selectedForReceipt?.tier ?? 0,
      routingReason,
      totalCostUsd: summary.totalCostUsd,
      totalTokensInput: summary.totalTokensInput,
      totalTokensOutput: summary.totalTokensOutput,
      totalCalls: summary.totalCalls,
    }));
  }
}

if (import.meta.main) {
  await runWorkbench();
}
