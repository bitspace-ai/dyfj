# DYFJ

**Vendor-agnostic persistence and routing substrate for personal AI stacks.**

Dolt for memory. Three-tier model routing with consent gates. MCP server that works
with any coding agent. No proprietary runtime dependency.

---

## The Problem

Most personal AI setups are built on top of a specific provider's tooling — Claude Code,
Cursor, Codex. That's fine until it isn't. The skills you build, the sessions you log,
the context you accumulate: all of it lives inside someone else's walls.

DYFJ is the layer underneath — persistence and routing that you own, exposed over
standard protocols, swappable at every seam.

## What's In The Box

### Dolt persistence

Every model call, session, memory, and reflection lands in a
[Dolt](https://github.com/dolthub/dolt) database — SQL with git semantics.

That means:

- **Time-travel queries** — `AS OF` lets you query data as it existed at any past commit.
  Replay a session from any checkpoint. Audit what context the model had when it made
  a decision. Diff two runs of the same task.
- **Branch and merge** — experimental agent workspaces as branches; merge when done.
- **Standard SQL** — MySQL 8.0 dialect. Any tool that speaks MySQL works.

The schema has OTel trace/span IDs and identity (`principal_id`, `authz_basis`) as
structural NOT NULL fields on the `events` table. Not a plugin. Not optional. Every
telemetry event carries trace and principal context by construction.

### Three-tier model router

```
Tier 0 — Local (Ollama)        free, sovereign, default
Tier 1 — API light (Haiku, Flash)   explicit opt-in, session-sticky consent
Tier 2 — API heavy (Sonnet, Opus)   explicit opt-in, per-call consent + cost estimate
```

Consent is a first-class concept. The router prompts before spending money and shows
cost estimates. Tier 1 grants are sticky for a session; Tier 2 prompts every call.
Local models run without any gate.

### MCP server

`mcp/server.ts` exposes the memory substrate over
[Model Context Protocol](https://modelcontextprotocol.io) (stdio transport).
Any agent runtime that speaks MCP can read and write memories, start sessions,
and write reflections — without knowing anything about Dolt.

Works with Claude Code, Codex CLI, Gemini CLI, Cursor, or anything else that
supports MCP servers.

### Pi extension

`.pi/extensions/dyfj-memory.ts` wires Dolt memory into
[pi](https://github.com/badlogic/pi-mono) session context at startup.
Reference implementation for other runtime integrations.

---

## Schema

DDL at `schema/*.sql`. The schema is the contract — TypeScript types are derived
consumers, never the definition.

| Table | Purpose |
|-------|---------|
| `events` | Runtime telemetry — model calls, tool use, cost, errors |
| `memories` | Durable context — user profile, project state, references |
| `sessions` | Units of work — metadata + freeform content |
| `reflections` | End-of-session synthesis — structured for aggregate analysis |
| `tasks` | Work items |
| `models` | Model registry — capabilities, tiers, cost rates |
| `skills` | Available capabilities and descriptions |

---

## Getting Started

### Prerequisites

- [Bun](https://bun.sh)
- [Dolt](https://docs.dolthub.com/introduction/installation)
- [Ollama](https://ollama.com) with at least one model pulled (e.g. `ollama pull gemma4`)

### Setup

```bash
git clone https://github.com/bitspace-ai/dyfj
cd dyfj
bun install
cp .env.example .env
cp settings.example.json settings.json
```

Edit `.env` with your values. Edit `settings.json` to set your default model and provider.

### Initialize Dolt

```bash
mkdir -p data/dolt && cd data/dolt
dolt init
dolt sql-server &    # runs on localhost:3306 by default
cd ../..
```

Apply the schema:

```bash
for f in schema/*.sql; do
  dolt --data-dir data/dolt sql < "$f"
done
```

### Run

```bash
bun run src/index.ts
```

### Test the router

```bash
bun run examples/router-tour.ts
```

Walks through all three tiers, consent flow, and verifies events landed in Dolt.

---

## MCP Configuration

Point your agent at the MCP server. Replace `/path/to/bun` with `which bun`.

```json
{
  "mcpServers": {
    "dyfj-memory": {
      "command": "/path/to/bun",
      "args": ["run", "~/.dyfj/mcp/server.ts"]
    }
  }
}
```

See `mcp/README.md` for per-client configuration examples.

---

## Design Principles

- **Schema in the data layer** — DDL is the contract. No TypeScript-first schema definitions.
- **Local models by default** — Ollama first. API is explicit escalation.
- **Non-determinism is the point** — persistence makes artifacts durable; it doesn't constrain model behavior.
- **No OTel SDK** — trace/span IDs are plain strings. No collector required.
- **No RBAC engine** — log principal + action + resource. Derive policy from the event log.

---

## Status

Early and active. Core schema and routing are working. MCP server is functional.
Building in public — commit history reflects real decisions, including wrong ones.

Related work worth knowing about:
- [PAI](https://github.com/danielmiessler/PAI) — Daniel Miessler's personal AI infrastructure. Primary inspiration for the personal-stack concept.
- [Gas City](https://github.com/gastownhall/gascity) — Dolt-backed agent persistence, informed by Steve Yegge's Gas Town work. Convergent thinking.

---

## License

MIT
