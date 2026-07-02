# DYFJ Schema

Canonical data model for DYFJ, expressed as Dolt DDL.

## Why DDL is the source of truth

Event, memory, session, model, and prompt contracts live in Dolt DDL.
TypeScript and Rust bindings are consumers of that schema, not sources of
truth. If you want the product-level reason, see the project README's Layer 0
stance on data-layer schema.

## Layout

Use the readable current baseline for new databases:

- `current/001_structure.sql` — live structural schema for runtime-used tables:
  `events`, `memories`, `sessions`, `models`, and `prompts`.
- `catalog/001_models.sql` — mutable model catalog seed data.
- `catalog/002_prompts.sql` — trusted prompt catalog seed data.
- `migrations/` — forward migrations after the current baseline.
- `history/` — preserved replay history that preceded the current baseline.

The model and prompt catalogs are separated from structure because provider
availability, pricing, and prompt text change faster than the table contracts.

The historical replay files are provenance and validation input. They include
the earlier reflection/skills/capability experiments, authn metadata, model
catalog refreshes, session workspace/project fields, prompt table work, and
memory visibility/injection classification through `024_memories_inject.sql`.

## Apply the schema

Requires [Dolt](https://www.dolthub.com/). Apply from the Dolt database
directory so `dolt sql` targets the working set directly:

```sh
for dir in /path/to/dyfj/schema/current \
           /path/to/dyfj/schema/catalog \
           /path/to/dyfj/schema/migrations; do
  find "$dir" -maxdepth 1 -name '*.sql' | sort | while read -r f; do
    dolt sql < "$f"
  done
done
```

If a local `dolt sql-server` is already running, you can query it with Dolt
itself:

```sh
dolt --host 127.0.0.1 --port 3306 --no-tls \
  --user root --password "$DOLT_PASSWORD" --use-db dolt \
  sql -q "SHOW TABLES;"
```

## Validate the schema

Run the canonical validation against fresh disposable Dolt repositories:

```sh
deno task validate-schema
```

The command applies:

1. `schema/current/*.sql`
2. `schema/catalog/*.sql`
3. `schema/migrations/*.sql`

It also separately replays `schema/history/*.sql` to prove the preserved history
still parses and applies. That replay is provenance, not an upgrade path from
every historical state to the current baseline. Existing databases created
before a baseline cut should be migrated with files in `schema/migrations/` or
with an operator-reviewed manual migration before using current runtime code.
Validation fails on invalid DDL or ordering errors and confirms the `events`
table exists. It does not connect to or mutate any long-running local Dolt SQL
server.

## Forward migration workflow

For the current MVP, keep forward migrations as numbered SQL files in
`schema/migrations/` and update `schema/current/` when cutting a new readable
baseline.

If this becomes difficult to audit, the next step is a tiny DYFJ-native
migration ledger table that records applied migration ids and checksums. Do not
introduce an external migration framework before the repository needs that
weight.

## Why Dolt

Dolt gives MySQL-compatible SQL on top of git-like versioning — branches,
diffs, commits, time-travel. For a substrate that values an immutable record
alongside queryable working state, that combination is hard to replace with
anything else.
