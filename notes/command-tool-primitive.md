# Command / Tool Primitive

Status: design note.
Tracks: `dyfj-2fl.6` - Design DYFJ command/tool primitive.

> **Note (2026-06-14):** the `capability_*` events referenced below as a future representation of command registration were removed in `schema/018_drop_vestigial.sql` (unbuilt — no producer or consumer). The forward-looking framing still holds; the capability schema would be re-added as a clean migration when there are real consumers.

## Frame

Workbench needs one callable primitive that can be invoked from two places:

- a human/operator surface, such as a slash command, palette command, CLI command, or future Workbench UI action
- a model tool call, where the model requests the same action through a tool-shaped interface

Those should not be two systems. They should be the same command definition, permission envelope, executor, and event trail with different callers.

This is the smallest substrate for an Emacs-like self-building lane: DYFJ can expose actions to itself, inspect them, ask permission, run checks, and apply approved changes without allowing arbitrary live mutation.

## Non-goals

- Full companion design.
- General plugin marketplace.
- Dynamic runtime registry service.
- Remote execution.
- Multi-tenant policy.
- Arbitrary code evaluation.
- A second audit log.
- Object graphs with back-references between commands, calls, permissions, and events. Relationships are IDs plus event rows.

## Primitive

The internal noun is **command**. A model-facing tool is a projection of a command.

Minimal command definition:

```ts
interface CommandDefinition {
  id: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  permission: PermissionEnvelope;
  executor: CommandExecutor;
}
```

`id` is stable and dotted, matching the capability naming convention where possible:

- `memory.read`
- `budget.inspect`
- `worktree.propose_patch`
- `checks.run`
- `patch.apply`

`description` is human-readable and model-readable. It describes what the command does, not why a caller wants it.

`inputSchema` is the canonical call-shape schema. It is used by human forms, CLI argument validation, model tool schemas, tests, and permission checks.

`executor` receives a validated call plus an execution context. It does not decide permission. The executor is the bottom of the lane, not the policy layer.

## Permission Envelope

The permission envelope declares the command's possible effects before any call runs:

```ts
interface PermissionEnvelope {
  effects: CommandEffect[];
  defaultDecision: "allow" | "ask" | "deny";
  resources: ResourcePattern[];
  network?: "none" | "local" | "external";
  filesystem?: "none" | "read" | "write";
  cost?: "none" | "local" | "paid";
}
```

Example effects:

- `read.memory`
- `read.filesystem`
- `write.filesystem`
- `run.checks`
- `call.model.local`
- `call.model.paid`
- `emit.event`

The policy gate reasons about **call shape**, not model justification:

- command id
- principal id and principal type
- validated arguments
- declared effects
- normalized resource set
- cwd / path containment
- network scope
- paid-cost posture
- previous consent grants in the same session, if any

The gate ignores:

- model-written rationale
- natural-language promises
- hidden chain-of-thought or planning text
- any argument field that is not part of the command's schema

Policy returns one of:

- `allow` - execute and record `authz_basis=policy:<rule>`
- `ask` - render the exact call shape and require human approval
- `deny` - do not execute; record the denial

If approval is granted, execution records `authz_basis=user_consent:<event_id>` or another stable consent reference. The consent event can be added later; Day 1 may store the prompt/decision in the command event content if no dedicated consent event exists yet.

## Invocation Surfaces

### Human / Operator

A human invocation creates the same call record a model tool call would create:

```ts
{
  commandId: "memory.read",
  callId: "01...",
  caller: { principalId: "operator", principalType: "human" },
  arguments: { slug: "project_dyfj" }
}
```

The UI may be a CLI, command palette, slash command, or future Workbench panel. It does not bypass policy.

### Model Tool

The model sees a generated tool projection:

```ts
{
  name: "memory.read",
  description: "...",
  parameters: inputSchema
}
```

When the model calls it, Workbench converts the tool call into the same command call record:

```ts
{
  commandId: "memory.read",
  callId: modelToolCallId,
  caller: { principalId: activeAgentId, principalType: "agent" },
  arguments: validatedArguments
}
```

The model can request the command. It cannot grant itself authority to execute it.

## Events

Day 1 should use the existing `tool_call` event row as the command-call projection:

| Field | Value |
|---|---|
| `event_type` | `tool_call` |
| `principal_id` / `principal_type` | caller |
| `action` | `invoke` or `deny` |
| `resource` | `command:<command_id>` |
| `authz_basis` | `policy:<rule>`, `user_consent:<id>`, or `policy:deny:<rule>` |
| `tool_name` | command id |
| `tool_call_id` | command call id |
| `tool_arguments` | validated command arguments |
| `tool_result` | executor result or denial summary |
| `tool_is_error` | true for deny/error, false for success |
| `content` | short human-readable summary |

This keeps the immutable log as the ground truth without adding a command-specific event enum before the runtime exists. If the name `tool_call` becomes misleading once human commands are common, add `command_call` / `command_result` / `command_denied` in a schema migration and keep `tool_call` as a compatibility projection.

Command registration can also be represented later through capability events:

- `capability_provide` with `capability_name=command.memory.read`
- `capability_metadata` carrying description, input schema hash, permission summary, and executor binding

For the first slice, a static in-process registry is enough.

## Static Registry Shape

Day 1 registry:

```ts
const commands: Record<string, CommandDefinition> = {
  "memory.read": readMemoryCommand,
};
```

The registry is interface-only and static-config-backed, matching README Section 1. It supports:

- `register(definition)`
- `lookup(commandId)`
- `list()`
- `projectTools()` for model-facing tool schemas

No leasing, daemon, dynamic discovery, or remote command loading yet.

## First Boring Command

Register `memory.read` first.

Why this command:

- already exists conceptually in the MCP memory server
- read-only
- local-first
- cheap to permission
- useful from both human and model surfaces
- exercises the complete lane without file writes or paid inference

Definition sketch:

```ts
{
  id: "memory.read",
  title: "Read Memory",
  description: "Load one Dolt-backed memory by slug.",
  inputSchema: {
    type: "object",
    required: ["slug"],
    properties: {
      slug: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]*$" }
    },
    additionalProperties: false
  },
  permission: {
    effects: ["read.memory", "emit.event"],
    defaultDecision: "allow",
    resources: ["memory:*"],
    network: "local",
    filesystem: "none",
    cost: "none"
  }
}
```

Acceptance for this command is not "memory works." Memory already works. Acceptance is that the same command definition can be:

- invoked by an operator command path
- projected as a model tool
- checked by policy
- executed
- recorded as a `tool_call` event

## Safe Self-Building Lane

The self-building lane should be a chain of boring commands, not arbitrary live mutation:

1. `worktree.propose_patch`
   - Input: target files, intent, proposed diff.
   - Effects: `read.filesystem`, `emit.event`.
   - Decision: allow for proposal generation; no writes.

2. `checks.run`
   - Input: approved command list, cwd, check names.
   - Effects: `run.checks`, maybe `read.filesystem`.
   - Decision: ask or allow depending on command allowlist.

3. `patch.apply`
   - Input: exact diff, target files, expected preimage hashes.
   - Effects: `write.filesystem`.
   - Decision: ask.
   - Gate: path containment, preimage match, no ignored/private paths, no destructive deletion unless explicitly approved.

4. `changes.summarize`
   - Input: changed files and check results.
   - Effects: `read.filesystem`, `emit.event`.
   - Decision: allow.

This lane allows DYFJ to build from within itself while preserving the core safety property: proposals are cheap and local; writes require exact call-shape approval; all material operations are evented.

## Acceptance Criteria

- A design note defines command id, description, input schema, permission envelope, executor, and events emitted.
- The note explains that human/operator commands and model tool calls invoke the same primitive through different projections.
- Permission checks reason about call shape and declared effects, not model justification.
- Day-1 eventing uses the existing immutable `events` log, with `tool_call` as the command-call projection.
- The first command to register is `memory.read`.
- The self-building lane is scoped to propose patch -> run checks -> ask approval -> apply exact patch.
- The registry is static and in-process for Day 1.
- The design stays below full companion design.

## Decisions

- Command schemas are authored in Zod in the TypeScript prototype and projected to JSON Schema for model-facing tools. JSON Schema is the interop shape; Zod is the prototype implementation detail.
- Command denials are recorded as `tool_call` events with `action='deny'`, `tool_is_error=true`, and `authz_basis='policy:deny:<rule>'`.
- The first operator surface is an internal `invokeCommand()` API exercised by tests. CLI or slash-command parsing comes after the primitive is proven.
- `memory.read` initially calls the local memory module. MCP remains an external surface that can later project or invoke the same command registry.

## First Implementation Work Items

1. Add a small `prototype/src/commands.ts` registry with `register`, `lookup`, `list`, and `projectTools`.
2. Add `CommandDefinition`, `PermissionEnvelope`, and `CommandCall` types.
3. Register `memory.read` using the existing Dolt memory read path.
4. Add a policy function that returns `allow | ask | deny` from command id, caller, args, and declared effects.
5. Write one `tool_call` event for command success/denial.
6. Add tests proving `memory.read` works from both operator-call and model-tool-call projections.
7. Only after that, add the first write-capable self-building command as a separate issue.
