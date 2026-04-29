# DYFJ Schema

Canonical data model for DYFJ, expressed as Dolt DDL.

## Why DDL is the source of truth

A core stance of DYFJ is that data contracts live in the data layer, not in language types. TypeScript and Rust bindings derived from these tables are *consumers*, not authoritative. If you want to understand why, see the project README's Layer 0 stance on schema-in-data-layer.

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

(Migration `005_*` is intentionally absent here; it lives in implementation-specific overlays where it belongs, not in the canonical substrate.)

## Apply the schema

Requires [Dolt](https://www.dolthub.com/) with the SQL server running. From this directory:

```sh
for f in *.sql; do
    dolt sql -q "$(cat "$f")"
done
```

Order matters because some tables reference others. The numeric prefix encodes the order.

## Why Dolt

Dolt gives MySQL-compatible SQL on top of git-like versioning — branches, diffs, commits, time-travel. For a substrate that values an immutable record alongside queryable working state, that combination is hard to replace with anything else.
