// Builders for engine unit and component tests: the ports a native turn runs
// against, wired to in-repo fakes, and OpenAI-compatible replies for the
// scripted provider transport. Runtime code never imports this module.

import { ManualClock } from "../fakes/manual-clock.ts";
import { MapEnv } from "../fakes/map-env.ts";
import {
  type ScriptedExchange,
  ScriptedHttpTransport,
} from "../fakes/scripted-http-transport.ts";
import {
  type MemorySeed,
  MemoryStore,
  type ModelSeed,
  type PromptSeed,
  type Store,
} from "../../src/store/mod.ts";
import { CeilingConfirmationStore } from "../../src/budget/mod.ts";
import { SessionOwners } from "../../src/engine/mod.ts";
import {
  type NativeTurnPorts,
  type NativeWorkbenchRuntimeResult,
  runWorkbenchRuntime,
  type WorkbenchRuntimeInput,
  type WorkbenchRuntimeServices,
} from "../../src/engine/mod.ts";
import type { RecordedRequest } from "../fakes/scripted-http-transport.ts";

/** A local OpenAI-compatible model on a loopback URL: free, tier 0. */
export const LOCAL_MODEL: ModelSeed = {
  slug: "local-chat",
  display_name: "Local Chat",
  provider: "ollama",
  api: "openai-completions",
  base_url: "http://127.0.0.1:11434/v1",
  tier: 0,
  context_window: 32_768,
  max_output_tokens: 4_096,
  capabilities: ["text", "code"],
};

/**
 * A priced model on the same loopback endpoint: tier 1, so the paid path
 * (consent, ceilings, anomaly stops) applies. Prices are per million tokens.
 */
export function pricedLocalModel(
  price: { costInput: number; costOutput: number },
): ModelSeed {
  return {
    ...LOCAL_MODEL,
    slug: "local-priced",
    display_name: "Local Priced",
    tier: 1,
    cost_input: price.costInput,
    cost_output: price.costOutput,
  };
}

/**
 * A free row that is NOT on-machine: tier 0, but a hosted provider on a
 * hosted URL. Its adapter reads `ANTHROPIC_API_KEY` through the env port.
 */
export const HOSTED_FREE_MODEL: ModelSeed = {
  slug: "hosted-free",
  display_name: "Hosted Free",
  provider: "anthropic",
  api: "anthropic-messages",
  base_url: "https://api.anthropic.com",
  tier: 0,
  context_window: 32_768,
  max_output_tokens: 4_096,
  capabilities: ["text", "code"],
};

/** A non-streaming Anthropic messages reply. */
export function anthropicReply(text: string): ScriptedExchange {
  return {
    respond: {
      body: JSON.stringify({
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    },
  };
}

/** One curated memory that loads as content and one that loads as index. */
export const MEMORIES: readonly MemorySeed[] = [
  {
    memory_id: "mem-core",
    slug: "operator-context",
    type: "user",
    visibility: "public",
    inject: "always",
    name: "Operator Context",
    description: "who the operator is",
    content: "The operator prefers short answers.",
  },
  {
    memory_id: "mem-index",
    slug: "project-context",
    type: "project",
    visibility: "public",
    inject: "index",
    name: "Project Context",
    description: "what the project is",
    content: "The project is a workbench.",
  },
];

export interface EngineStoreSeed {
  models?: readonly ModelSeed[];
  prompts?: readonly PromptSeed[];
  memories?: readonly MemorySeed[];
}

export interface EnginePortsOptions extends EngineStoreSeed {
  env?: Record<string, string>;
  /** First clock reading. Default 1_000_000. */
  start?: number;
}

export interface EngineFakes {
  ports: NativeTurnPorts;
  store: MemoryStore;
  clock: ManualClock;
  env: MapEnv;
}

/** Stage ports over a seeded `MemoryStore`, a manual clock and a map env. */
export function enginePorts(options: EnginePortsOptions = {}): EngineFakes {
  const clock = new ManualClock({ start: options.start ?? 1_000_000 });
  const store = new MemoryStore({
    models: options.models ?? [LOCAL_MODEL],
    prompts: options.prompts ?? [],
    memories: options.memories ?? MEMORIES,
  }, { now: clock.date });
  const env = new MapEnv(options.env ?? {});
  return {
    store,
    clock,
    env,
    ports: {
      store,
      budgetScopes: new SessionOwners(new CeilingConfirmationStore(clock)),
      clock,
      env,
      providerIo: {},
    },
  };
}

export interface ChatReply {
  content?: string;
  toolCalls?: ReadonlyArray<{ id: string; name: string; arguments: unknown }>;
  finishReason?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    completion_tokens_details?: { reasoning_tokens: number };
    prompt_tokens_details?: { cached_tokens: number };
  };
}

/** A non-streaming OpenAI chat-completions reply. */
export function chatReply(reply: ChatReply = {}): ScriptedExchange {
  return {
    respond: {
      body: JSON.stringify({
        choices: [{
          message: {
            content: reply.content ?? "",
            ...(reply.toolCalls === undefined ? {} : {
              tool_calls: reply.toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.arguments),
                },
              })),
            }),
          },
          finish_reason: reply.finishReason ??
            (reply.toolCalls ? "tool_calls" : "stop"),
        }],
        usage: reply.usage ?? { prompt_tokens: 42, completion_tokens: 7 },
      }),
    },
  };
}

/** A temp directory holding `files`, removed by the returned disposer. */
export async function tempWorkspace(
  files: Record<string, string> = {},
  prefix = "engine-workspace-",
): Promise<{ root: string; [Symbol.asyncDispose](): Promise<void> }> {
  const root = await Deno.makeTempDir({ prefix });
  for (const [path, content] of Object.entries(files)) {
    await Deno.writeTextFile(`${root}/${path}`, content);
  }
  return {
    root,
    [Symbol.asyncDispose]: () => Deno.remove(root, { recursive: true }),
  };
}

export interface EngineRun extends EngineFakes {
  transport: ScriptedHttpTransport;
  services: WorkbenchRuntimeServices;
}

/**
 * Runtime services for a whole turn: the stage fakes plus a scripted provider
 * transport that answers the provider calls in `exchanges` order.
 */
export function engineServices(
  exchanges: readonly ScriptedExchange[],
  options: EnginePortsOptions = {},
): EngineRun {
  const fakes = enginePorts(options);
  const transport = new ScriptedHttpTransport(exchanges);
  return {
    ...fakes,
    transport,
    services: {
      store: fakes.store,
      budgetScopes: fakes.ports.budgetScopes,
      clock: fakes.clock,
      env: fakes.env,
      http: transport.fetch,
    },
  };
}

/**
 * The store with some readers or the journal replaced, as a failing adapter
 * would behave. Everything not replaced is the original store's.
 */
export function patchStore(store: Store, patch: Partial<Store>): Store {
  return {
    journal: patch.journal ?? store.journal,
    events: patch.events ?? store.events,
    sessions: patch.sessions ?? store.sessions,
    memories: patch.memories ?? store.memories,
    models: patch.models ?? store.models,
    prompts: patch.prompts ?? store.prompts,
    spend: patch.spend ?? store.spend,
    close: () => store.close(),
  };
}

/** Run one native turn against `run`'s fakes, on the local model by default. */
export function runTurn(
  run: EngineRun,
  input: Partial<WorkbenchRuntimeInput>,
): Promise<NativeWorkbenchRuntimeResult> {
  return runWorkbenchRuntime({
    mode: "turn",
    prompt: "hello",
    routingOptions: {},
    defaultCompanionModel: LOCAL_MODEL.slug,
    ...input,
    runner: undefined,
  }, run.services);
}

export interface ChatRequestMessage {
  role: string;
  content: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

/** The chat-completions body a provider request carried. */
export function requestBody(request: RecordedRequest): {
  model?: string;
  messages: ChatRequestMessage[];
  tools?: unknown[];
  stream?: boolean;
} {
  return JSON.parse(request.body);
}

/** The system message of a provider request. */
export function systemMessage(request: RecordedRequest): string {
  return requestBody(request).messages.find((message) =>
    message.role === "system"
  )?.content ?? "";
}

/** The non-system messages of a provider request. */
export function conversation(request: RecordedRequest): ChatRequestMessage[] {
  return requestBody(request).messages.filter((message) =>
    message.role !== "system"
  );
}

/** Every event row the turn wrote, in commit order. */
export async function eventRows(run: EngineRun, sessionId: string) {
  return await run.store.events.bySession({
    sessionId,
    limit: 500,
    order: "asc",
  });
}
