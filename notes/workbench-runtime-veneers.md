# Workbench Runtime Veneers

Status: implemented runtime/veneer inventory for `dyfj-f30`.

## Current Entry Points

- `prototype/deno.json` exposes `deno task workbench`, which runs
  `src/workbench.ts`.
- `prototype/src/workbench.ts` owns CLI argument parsing in
  `resolveWorkbenchInvocation()`.
- `runWorkbench()` resolves the invocation, dispatches `shell` mode to
  `runWorkbenchShell()`, and sends single-turn modes through
  `runWorkbenchRuntime()`.
- `runWorkbenchShell()` is the current interactive shell loop. It reads prompts,
  handles `:session` and `:quit`, and then calls
  `runWorkbench(["--prompt", prompt])`.
- `prototype/examples/verify-workbench-events.ts` calls `runWorkbench()`
  directly for event-sequence verification.

## Runtime Behavior Currently Inside `workbench.ts`

`runWorkbenchRuntime()` owns the single-turn runtime path. It:

- creates the command registry with `createCommandRegistry()` and
  `registerCoreCommands()`;
- creates session and trace ids;
- loads either repo-local ask context or memory/index context;
- writes `session_start`, `model_selected`, `tool_call`, `model_response`,
  `budget_summary`, and `session_end` events where applicable;
- creates and updates a `sessions` row;
- loads and selects models;
- runs budget preflight and paid-escalation consent;
- calls `runWorkbenchTurn()`;
- executes model-requested command/tool calls through
  `invokeCommandWithEvent()`;
- validates `next-work` JSON output;
- records budget usage;
- builds and prints the receipt.

Some console rendering is still mixed into the runtime path, but CLI/shell/HTTP
now share the same runtime state, event writes, and session persistence.

## Supporting Runtime Modules

- `prototype/src/provider.ts` owns model selection, OpenAI-compatible request
  shaping, streaming/non-streaming parsing, tool-call parsing, timings, usage,
  and cost calculation for a model turn.
- `prototype/src/commands.ts` owns the command registry, policy check,
  `memory.read`, model-facing tool projection, and `tool_call` event payload.
- `prototype/src/sessions.ts` owns Workbench session slug/content creation and
  `sessions` table writes.
- `prototype/src/budget.ts` owns per-session budget tracking, pre-call checks,
  summaries, and budget-summary event payloads.
- `prototype/src/repo-context.ts` owns repo-local context loading for `ask` and
  `next-work`.
- `prototype/src/memory.ts` owns full user/feedback memory loading and
  project/reference memory indexing for generic `turn`.

## Runtime Boundary

The implemented shared runtime API lets CLI, shell, and HTTP call the same
single-turn behavior:

```ts
export interface WorkbenchRuntimeInput {
  mode: Exclude<WorkbenchInvocation["mode"], "shell">;
  prompt: string;
  routingOptions: WorkbenchRoutingOptions;
  onTextDelta?: (delta: string) => void;
  confirmPaidEscalation?: (banner: string) => Promise<void>;
}

export interface WorkbenchRuntimeResult {
  sessionId: string;
  traceId: string;
  text: string;
  receipt: string;
  model: {
    displayName: string;
    slug: string;
    provider?: string;
    api?: string;
    tier: 0 | 1 | 2;
  };
  route: {
    reason: string;
  };
  cost: {
    estimatedUsd: number;
    totalUsd: number;
    paidInferenceUsed: boolean;
  };
  tokens: {
    input: number;
    output: number;
    totalCalls: number;
  };
  context: {
    profile?: AskContextProfile;
    sources: string[];
    budget?: PackedContextSummary;
  };
  validation?: WorkbenchValidationSummary;
}
```

The boundary keeps these invariants:

- CLI and HTTP pass inputs to runtime; neither owns model selection, command
  execution, session writes, event writes, or receipt facts.
- Streaming is optional presentation. The runtime can accept an `onTextDelta`
  callback, but final result text still belongs in `WorkbenchRuntimeResult`.
- Paid escalation consent is injected. CLI can prompt on TTY; HTTP can fail
  closed or use an explicit future approval route.
- The runtime result exposes cost/model/budget/session/trace facts as structured
  data before any veneer renders them.
- Shell mode stays outside the runtime boundary because it is a loop over turns,
  not a single turn.

## Runtime Observer Events

`runWorkbenchRuntime()` also accepts one observer callback:
`onRuntimeEvent(event)`.

The observer exists for runtime legibility. It lets veneers or smoke tests watch
the current runtime spine without owning runtime behavior, replacing provider
calls, or installing a plugin/middleware chain.

The current MVP event set is:

- `sessionStart`
- `inputReceived`
- `contextBuilt`
- `modelSelected`
- `beforeProviderRequest`
- `afterProviderResponse`
- `turnCompleted`
- `turnFailed`

Payloads stay small: ids, model/tier, routing reason, token counts, timings,
context source counts, and prompt length. They do not carry full prompts, full
context, tool output, or model text. Observer failures are best-effort; the
runtime logs the observer failure and preserves the turn result.

## Implemented Extraction

- `prototype/src/workbench.ts` now exports `WorkbenchRuntimeInput`,
  `WorkbenchRuntimeEvent`, `WorkbenchRuntimeResult`,
  `buildWorkbenchRuntimeInput()`, and `runWorkbenchRuntime()`.
- `runWorkbench()` parses CLI args, injects CLI stream and paid-consent
  callbacks, calls `runWorkbenchRuntime()`, and returns the structured runtime
  result.
- `runWorkbenchShell()` remains the shell loop and calls `runWorkbench()` for
  each prompt.
- `prototype/src/http.ts` exposes `createWorkbenchHttpHandler()`, `GET /`, and
  `POST /api/turn` over `runWorkbenchRuntime()`.
- Root and prototype manifests expose `deno task workbench-http`; the default
  local URL is `http://127.0.0.1:8787/`.

## Risks

- `runWorkbenchRuntime()` still prints some progress/receipt output while it
  runs. The HTTP response does not parse console output, but future cleanup can
  move all rendering fully into veneers.
- Paid inference consent is injected. The HTTP veneer currently fails closed for
  paid inference instead of inheriting the TTY prompt path.
- `bestEffortEvents` currently differs for repo ask context. The runtime should
  preserve that behavior until there is a clearer policy.
- `turn` mode exposes command tools; `ask` and `next-work` do not. That
  distinction should remain runtime behavior, not veneer behavior.
- The receipt is currently a string. HTTP should return structured facts and may
  include the receipt string for parity, but should not parse the receipt to
  recover facts.
