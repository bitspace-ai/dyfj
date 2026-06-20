# DYFJ Schema

Canonical data model for DYFJ, expressed as Dolt DDL.

## Why DDL is the source of truth

Event and memory contracts live in Dolt DDL. TypeScript and Rust bindings are consumers of that schema, not sources of truth. If you want to understand why, see the project README's Layer 0 stance on data-layer schema.

## Files

Migrations are numbered and applied in order:

- `001_events.sql` — append-only runtime telemetry. Every model call, tool invocation, error. OTel correlation fields and security/audit fields are structural, not optional.
- `002_memories.sql` — durable context (user profile, feedback, environment, project, reference). Structured metadata + freeform `TEXT` content for model interpretation.
- `003_sessions.sql` — units of work, with structured metadata for queries and freeform markdown for the model.
- `004_reflections.sql` — distilled lessons from completed sessions. **Dropped by `018` (vestigial — unused by the runtime, superseded in spirit by work-shaped-evals).**
- `006_models.sql` — registry of available models (local and remote), capabilities, costs.
- `007_events_model_selected.sql` — adds the `model_selected` event type (routing decisions, including rejected candidates).
- `008_events_budget_summary.sql` — adds the `budget_summary` event type (one cost/token ledger row per session).
- `009_skills.sql` — invokable skills as Dolt-stored prompt templates. **Dropped by `018` (vestigial — unused by the runtime, redundant with `017_prompts`).**
- `010_events_capability.sql` — bilateral capability/discovery events (provide/require/match/release) and lease-aware lookup fields. **Reverted by `018` (a Day-1 registry bet emitted by nothing; re-add as a clean migration when the routing-registry work is real).**
- `011_events_authn.sql` — authentication metadata for the acting principal on event rows. Adds primitive authn fields for status, mechanism, issuer/session references, assertion times, and evidence pointers; credential material remains out of scope.
- `012_models_2026_06_refresh.sql` — registry refresh: current Anthropic lineup with cache economics, the MLX local default, Opus 4.5 deprecated.
- `013_sessions_project.sql` — adds the `project` column to `sessions` so Workbench sessions group by project.
- `014_models_openai_2026_06.sql` — hosted OpenAI (GPT) rows; deactivates the adapterless Gemini rows.
- `015_models_gemini_2026_06.sql` — current Gemini rows behind the native adapter.
- `016_models_local_coder_default.sql` — local default moves to the capable open-weights coder model (Qwen3-Coder-30B-A3B) on high-memory Apple Silicon; deactivates the prior small local default.
- `017_prompts.sql` — authored, versioned system prompts (trusted config), kept separate from the untrusted memory layer.
- `018_drop_vestigial.sql` — schema reconciliation: drops `reflections` and `skills`, and removes the unused capability/discovery event scaffolding from `010`.
- `019_memories_visibility.sql` — memory visibility classification (privacy/visibility metadata on the memory layer).
- `020_sessions_workspace.sql` — sessions gain a workspace binding.
- `021_models_validity_2026_06.sql` — registry validity (BIT-168): corrects the Anthropic Haiku slug to its dated API id (`claude-haiku-4-5-20251001`) and deactivates the Google rows (`gemini-3.1-pro` 404s; `gemini-3.5-flash` could not be verified) pending provider-id verification and Google key-configuration cleanup, so the picker stops surfacing models that fail at call time.

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
