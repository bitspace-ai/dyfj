# DYFJ Schema

Canonical data model for DYFJ, expressed as Dolt DDL.

## Why DDL is the source of truth

Event and memory contracts live in Dolt DDL. TypeScript and Rust bindings are consumers of that schema, not sources of truth. If you want to understand why, see the project README's Layer 0 stance on data-layer schema.

## Files

Migrations are numbered and applied in order:

- `001_events.sql` — append-only runtime telemetry. Every model call, tool invocation, error. OTel correlation fields and security/audit fields are structural, not optional.
- `002_memories.sql` — durable context (user profile, feedback, environment, project, reference). Structured metadata + freeform `TEXT` content for model interpretation.
- `003_sessions.sql` — units of work, with structured metadata for queries and freeform markdown for the model.
- `004_reflections.sql` — distilled lessons from completed sessions.
- `006_models.sql` — registry of available models (local and remote), capabilities, costs.
- `007_events_model_selected.sql` — typed view of model-selection events.
- `008_events_budget_summary.sql` — typed view of budget-summary events.
- `009_skills.sql` — invokable skills (named, parameterized actions composable into agent loops).
- `010_events_capability.sql` — bilateral capability/discovery events (provide/require/match/release) and lease-aware lookup fields. Day-1 schema commitment so the runtime registry is derivable from the log later.
- `011_events_authn.sql` — authentication metadata for the acting principal on event rows. Adds primitive authn fields for status, mechanism, issuer/session references, assertion times, and evidence pointers; credential material remains out of scope.

(Migration `005_*` is intentionally absent here; it lives in implementation-specific overlays where it belongs, not in the canonical substrate.)

## Apply the schema

Requires [Dolt](https://www.dolthub.com/). Apply from the Dolt database directory so `dolt sql` targets the working set directly:

```sh
for f in /path/to/dyfj/schema/*.sql; do
    dolt sql < "$f"
done
```

Order matters because some tables reference others. The numeric prefix encodes the order.

If a local `dolt sql-server` is already running, you can query it with Dolt itself:

```sh
dolt --host 127.0.0.1 --port 3306 --no-tls \
  --user root --password "$DOLT_PASSWORD" --use-db dolt \
  sql -q "SHOW TABLES;"
```

## Validate the schema

Run the canonical DDL against a fresh disposable Dolt repository:

```sh
deno task validate-schema
```

The command applies `schema/*.sql` in lexical order, fails on invalid DDL or ordering errors, and confirms the `events` table exists. It does not connect to or mutate any long-running local Dolt SQL server.

## Why Dolt

Dolt gives MySQL-compatible SQL on top of git-like versioning — branches, diffs, commits, time-travel. For a substrate that values an immutable record alongside queryable working state, that combination is hard to replace with anything else.
