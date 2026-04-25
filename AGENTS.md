# AGENTS.md — DYFJ Workbench

## What This Is

DYFJ is a vendor-agnostic persistence and routing substrate for personal AI stacks.
It provides three things:

1. **Dolt-backed memory and session persistence** — SQL with git semantics. Every model
   call, session, memory, and reflection is durable, auditable, and time-travelable.
2. **Three-tier model router** — local models (Ollama) by default, API escalation by
   explicit consent. Cost is visible before it is incurred.
3. **MCP server** — exposes the memory substrate to any agent runtime that speaks MCP.
   Not tied to any one coding agent or AI provider.

DYFJ is infrastructure. It does not prescribe workflows, skills, or methodologies —
those belong to the person running it.

## Attribution

The conviction that a personally-owned AI stack is worth building came largely from
[Daniel Miessler's](https://danielmiessler.com) work on
[PAI](https://github.com/danielmiessler/PAI). The use of Dolt as the persistence layer
was informed by [Steve Yegge's](https://steve-yegge.medium.com) Gas Town work and the
[Gas City](https://github.com/gastownhall/gascity) project. Neither is a direct
dependency — DYFJ is a distinct design built on convergent intuitions.

## Architecture

```
Agent runtime (any)
    ↓ MCP (stdio)
dyfj-memory MCP server        exposes: memories, sessions, reflections
    ↓ mysql2 (TCP)
Dolt sql-server               git-semantics SQL, time-travel queries
```

For direct integration (without MCP):

```
pi coding agent
    ↓ TypeScript extension
.pi/extensions/dyfj-memory.ts  loads Dolt memories into session context
    ↓ mysql2 (TCP)
Dolt sql-server
```

**Key components:**
- `mcp/server.ts` — MCP server, stdio transport
- `src/router.ts` — three-tier model router with consent gates
- `src/memory.ts` — memory loading and system prompt assembly
- `src/budget.ts` — per-session token and cost tracking
- `src/index.ts` — reference entry point (pi integration)
- `.pi/extensions/dyfj-memory.ts` — pi extension wiring Dolt into session lifecycle
- `schema/*.sql` — Dolt DDL; the schema is the contract

## Data Model

Schema DDL lives at `schema/*.sql`. The schema is the source of truth —
TypeScript types are derived consumers, never the definition.

| Table | Purpose |
|-------|---------|
| `events` | Runtime telemetry — every model call, tool use, cost event |
| `memories` | Durable context — user profile, project state, references |
| `sessions` | Units of work — structured metadata + freeform content |
| `reflections` | End-of-session synthesis — structured for aggregate analysis |
| `tasks` | Work items — synced from external sources or created directly |
| `models` | Model registry — capabilities, tiers, cost rates |
| `skills` | Skill index — available capabilities and their descriptions |

**OTel and identity are structural, not optional.** The `events` table requires
`trace_id`, `span_id`, `principal_id`, and `authz_basis` as NOT NULL fields.
You cannot emit a telemetry event without identity and tracing context.

## Design Principles

- **Schema in the data layer** — Dolt DDL is the contract. Application code derives types from it.
- **Dolt as filing cabinet, not straitjacket** — structured columns for filtering, freeform TEXT for content the model interprets. Don't constrain model behavior through schema.
- **Non-determinism is the point** — the model's emergent reasoning is the value. Persistence makes artifacts durable without prescribing behavior.
- **Local models by default** — Ollama first. API calls are explicit escalation with visible cost.
- **OTel and identity baked in** — not a plugin, not optional. Every event carries trace and principal context.
- **Time-sortable IDs** — ULID or UUIDv7 for primary keys. Sequential inserts benefit Dolt's prolly-tree structure.
- **Minimal indexes** — each index is a prolly-tree in Dolt with per-commit cost. Index only what you query.

## Language Philosophy

- **Rust** for anything close to the metal — agent runtimes, system integration, performance-sensitive paths. The primary reason is not memory safety or speed (though both matter) — Rust is exceptionally explicit when code is wrong. When an agent writes broken Rust, the compiler says exactly why. That property is a force multiplier in AI-assisted development.
- **TypeScript** for UI, DOM manipulation, and scripty glue. Strong typing catches agent errors at the boundary between intent and execution, without the weight of a systems language.
- **SQL (Dolt)** as the data contract layer. Schema lives in DDL, not in application code.

## Runtime

- **Runtime:** Bun (not Node.js)
- **Tests:** `bun test` from project root; `bun test src/<pattern>` for specific files
- **Dolt:** requires `dolt sql-server` running locally (default: `localhost:3306`)
- **Ollama:** `http://localhost:11434` (required for Tier 0 / local model routing)

## Constraints

- **No OTel SDK dependencies** — `trace_id` and `span_id` are plain strings. No collector, no agent, no SDK.
- **No RBAC engine** — log `principal_id` + `action` + `resource`. Derive policies from the event log later, if needed.
- **No schema normalization** — the wide-table design is intentional. Avoid splitting tables to satisfy normal forms.
- **No expensive API calls without consent** — the router enforces this. Don't bypass it.
- **No UI yet** — get the data layer right first.
