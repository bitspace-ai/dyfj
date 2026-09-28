# Recipe: add a tool

Status: normative for adding tools. It implements `01-architecture.md` section
5.4 and PRD-12 R2. The living example is the test-only `text.stats` tool in
`prototype/testing/tools/text-stats/`, which was written by following this
recipe and passes the kit.

Paths below are relative to `prototype/`.

## First: do you need a builtin at all?

A tool served by an MCP server needs **no code**: configure the server and the
tool under `[[mcp.servers]]` (`mcp-servers.ts` validates it) with its effect
(`read` or `write_external`) and approval. The external MCP adapter
(`src/mcp-tools.ts`) derives the `CommandDefinition` from the server's
discovered schema, and the catalog registers it with the other configured
external commands. A web search or fetch capability is the same, mapped through
`capabilities.search_tool` and `capabilities.fetch_tool`.

Stop here unless the tool runs inside the engine.

## Adding a builtin tool

Cost: one module, one catalog line, passing the tool conformance kit. Nothing in
`engine/`, the policy, the redactor or the invoke path changes.

### 1. The module

Create `src/tools/builtin/<name>.ts` (or add to the module of the family it
belongs to, as the file tools share `builtin/file.ts`). It holds the executor
and, beside it, the definition:

```ts
export function define<Name>(deps): CommandDefinition<string>;
```

`deps` is whatever the tool needs from the catalog (a workspace root, a reader);
take nothing from module state. The definition (`src/tools/definition.ts`)
declares:

- **Identity.** `id` is the name the model calls; it is part of the wire and of
  every `tool_call` event, so choose it once. Provider adapters make dotted ids
  wire-safe themselves. `title` names the approval prompt; `description` is the
  model's documentation of the tool, including what it will not do.
- **`inputSchema`.** An object schema. Declare every argument with its `type`,
  mark the required ones, and set `additionalProperties: false` unless the tool
  genuinely accepts open arguments. Validation runs before policy and before the
  executor, so the executor may convert declared arguments with `String()` and
  `Number()` without checking them again. Use `integer` rather than `number`
  where a fraction is meaningless, and `enum` for a closed set.
- **`permission`.** The envelope the policy reasons about: `effects` (always
  including `emit.event`), `defaultDecision`, `resources`, and `network`,
  `filesystem` and `cost`, all declared. State the ceiling of what the executor
  can do, not its intent: a tool that spawns a process carries a `run.*` effect
  even if it only reads, and one that can reach the network says so. The policy
  then decides:
  - read-only local access is allowed without approval;
  - a contained local write asks under `strict` and is auto-approved under the
    `operator` profile on a loopback turn;
  - process execution, spend, external writes and arbitrary network egress
    always ask;
  - `defaultDecision: "deny"` denies.
- **Redaction.** Mark a payload-bearing argument `redact: true` on its schema
  property (file content, message bodies). Set `redactResult: true` when the
  result can carry what the approver could not pre-screen (process output).
  `redactArguments: true` redacts every declared argument and drops undeclared
  ones. The shared redactor (`src/tools/redaction.ts`) applies exactly these
  declarations to the durable `tool_call` event; the model still receives the
  unredacted call and result within the turn.
- **Failures.** Return an `error: …` string for a failure the model should read
  and recover from. Throw `CommandExecutionError` with a public-safe reason for
  one that ends the call as an error. Its message is persisted, so it must not
  carry arguments, paths outside the workspace, or upstream error text.

### 2. One catalog line

Add an entry to `BUILTIN_TOOLS` in `src/tools/catalog.ts`. An entry returns the
tool from the catalog's dependencies, or `undefined` when one it needs is
absent; `workspaceTool(define)` covers the tools rooted at the workspace. The
order of `BUILTIN_TOOLS` is the order tools are offered to the model and listed
by `tools/list`, so append.

A dependency the catalog does not have yet goes on `ToolCatalogPorts` (a runtime
capability, such as a reader) or `ToolCatalogConfig` (a resolved setting), and
the composition root supplies it.

### 3. The conformance kit

Nothing to write: `src/tools/conformance.test.ts` runs `toolConformance`
(`testing/conformance/tool.ts`) over the builtin catalog with every dependency
supplied, so a new catalog line is covered by registration alone. The kit checks
that:

- the schema is valid, and invalid arguments are rejected before the executor
  runs or any approver is asked;
- the effects are declared and agree with the envelope;
- the policy verdict under `strict` and `operator` matches the effects;
- the declared redaction reaches the event payload;
- every invocation writes exactly one `tool_call` event.

If the tool needs a dependency the kit's catalog does not supply, add it there.
Update the list in "the kit covers every builtin tool" in the same file.

### 4. Unit tests and docs

- Test the executor next to its module (`src/tools/builtin/<name>.test.ts`) with
  real temp directories and port fakes. A tool that spawns processes takes an
  injectable runner, so its unit tests never spawn; the spawning path belongs in
  the integration tier.
- Adding a tool changes the model-facing toolset, `tools/list` and
  `tools/inspect`: add a `CHANGELOG.md` entry, update the tool list wherever the
  README describes the toolset, and expect the golden snapshots that list tools
  to change under that recorded decision.
