# DYFJ Schema

Canonical data model for DYFJ, expressed as Dolt DDL.

## Why DDL is the source of truth

Event, memory, session, model, and prompt contracts live in Dolt DDL.
TypeScript and Rust bindings are consumers of that schema, not sources of
truth. If you want the product-level reason, see the project README's Layer 0
stance on data-layer schema.

The TypeScript row types are generated from it: `codegen.ts` applies
`current/` then `catalog/` to a disposable Dolt repository, reads
`information_schema`, and writes `prototype/src/store/generated/rows.ts`
(`<Table>Row` and `<Table>Insert` shapes, column-name tuples, per-column
declarations, and the SQL enum unions). Never edit that file by hand;
regenerate it with `npm run schema:codegen` in the same change as the DDL.
The `schema.codegen` gate lane fails when the committed file is stale.

## Layout

Use the readable current baseline for new databases:

- `current/001_structure.sql` — live structural schema for runtime-used tables:
  `events`, `memories`, `sessions`, `models`, and `prompts`.
- `catalog/001_models.sql` — mutable model catalog seed data.
- `catalog/002_prompts.sql` — trusted prompt catalog seed data.
- `migrations/` — forward migrations that bring an existing database, created
  from `history/` before the current baseline cut, up to the current structure;
  their effects are already folded into `current/` and `catalog/`.
- `history/` — preserved replay history that preceded the current baseline.

The model and prompt catalogs are separated from structure because provider
availability, pricing, and prompt text change faster than the table contracts.

The `events` contract includes typed outer evidence for native provider calls
and external-agent runner turns. External-agent rows distinguish
profile-declared runner, transport, access-route, and cost-basis labels from
bounded evidence derived from the resolved workspace and protocol-observed
version, external session, stop reason, and a bounded subset of flattened
capability paths. They also record permission verdicts without
representing opaque inner activity as a provider call or model response.

The historical replay files are provenance and validation input. They include
the earlier reflection/skills/capability experiments, authn metadata, model
catalog refreshes, session workspace/project fields, prompt table work, and
memory visibility/injection classification through `024_memories_inject.sql`.

## Apply the schema

One rule decides what to apply:

- **Fresh install:** `current/` then `catalog/`. The forward migrations are
  already folded into that baseline and are never applied on top of it.
- **Existing database:** replay forward. A database created before the
  baseline cut has the structure `history/` ends with; apply the files in
  `migrations/` it has not yet applied, in order.

Both paths end at the same structure: the `schema.equivalence` gate lane
applies `current/` + `catalog/` and `history/` + `migrations/` to two
disposable repositories and fails on any structural difference (tables,
columns, types, nullability, defaults, indexes, enums, constraints). Catalog
data is not compared.

The Workbench engine checks this at boot: if its Dolt database is reachable and
lacks a column of a canonical table, it refuses to start and names the missing
columns, pointing here. It has no fallback for an un-migrated database.

Requires [Dolt](https://www.dolthub.com/). Apply from the Dolt database
directory so `dolt sql` targets the working set directly. A fresh install:

```sh
for dir in /path/to/dyfj/schema/current \
           /path/to/dyfj/schema/catalog; do
  find "$dir" -maxdepth 1 -name '*.sql' | sort | while read -r f; do
    dolt sql < "$f"
  done
done
```

To bring an existing database forward while `dolt sql-server` is running,
apply each unapplied file in `migrations/`, in order, as the migration user
(below), with `DOLT_PASSWORD` holding that user's password:

```sh
DOLT_CLI_PASSWORD="$DOLT_PASSWORD" dolt --host 127.0.0.1 --port 3306 \
  --no-tls --user dyfj_migrate --use-db dolt sql < /path/to/dyfj/schema/migrations/<file>.sql
```

## Dolt users

Give each process its own Dolt user, with only the grants its statements need,
and keep `root` for the operator. Table-level grants are enforced by Dolt's
SQL server (checked on Dolt 2.5.0). These are the grants on the `dolt`
database:

| User | Process | Grants |
|---|---|---|
| `dyfj_runtime` | Workbench runtime | `events`: `SELECT, INSERT`. `sessions`, `memories`: `SELECT, INSERT, UPDATE`. `models`, `prompts`: `SELECT` |
| `dyfj_mcp_memory` | MCP memory server (`prototype/mcp/`) | `memories`, `sessions`: `SELECT, INSERT, UPDATE` |
| `dyfj_migrate` | Applying migrations | `ALL PRIVILEGES` on `dolt.*`, without `GRANT OPTION` |

Why each grant is the size it is:

- **`events` is append-only for these users.** Only `dyfj_migrate` and `root`
  may update or delete it. A runtime started without `DOLT_USER` connects as
  `root`, so set it.
- **Upserts need `UPDATE`.** `INSERT … ON DUPLICATE KEY UPDATE` on an
  existing row is refused without it.
- **The runtime needs a grant on all five tables.** Its boot column check reads
  `information_schema.columns`, which lists only the tables a user holds a
  grant on.
- **The runtime holds no `DELETE`.** The only `DELETE` it can issue is a
  projector's, and `PHASE1_PROJECTORS` in `prototype/src/store/projectors.ts`
  is empty. A projector added later needs `DELETE` on its table, or its writes
  are refused.

Create them as `root`:

```sql
CREATE USER 'dyfj_runtime'@'localhost' IDENTIFIED BY '<password>';
GRANT SELECT, INSERT ON dolt.events TO 'dyfj_runtime'@'localhost';
GRANT SELECT, INSERT, UPDATE ON dolt.sessions TO 'dyfj_runtime'@'localhost';
GRANT SELECT, INSERT, UPDATE ON dolt.memories TO 'dyfj_runtime'@'localhost';
GRANT SELECT ON dolt.models TO 'dyfj_runtime'@'localhost';
GRANT SELECT ON dolt.prompts TO 'dyfj_runtime'@'localhost';

CREATE USER 'dyfj_mcp_memory'@'localhost' IDENTIFIED BY '<password>';
GRANT SELECT, INSERT, UPDATE ON dolt.memories TO 'dyfj_mcp_memory'@'localhost';
GRANT SELECT, INSERT, UPDATE ON dolt.sessions TO 'dyfj_mcp_memory'@'localhost';

CREATE USER 'dyfj_migrate'@'localhost' IDENTIFIED BY '<password>';
GRANT ALL PRIVILEGES ON dolt.* TO 'dyfj_migrate'@'localhost';
```

Keep the passwords out of argument lists and shell history:

- Send these statements to `dolt sql` on stdin, rendered from a secret
  manager's template.
- Give the `dolt` client its password through its environment, as in the
  examples here, not through `--password`.
- Point the runtime's `DOLT_PASSWORD` at a `[secrets.pointers]` entry.

These users bound SQL credentials only. While `dolt sql-server` runs,
`dolt sql` run inside the database directory logs in as Dolt's local
superuser, through `.dolt/sql-server.info`. Any process that can read the data
directory, or write its config and privilege files, therefore has full access,
whatever the SQL users are. Keep the data directory out of reach of the
processes the grants are meant to limit.

If a local `dolt sql-server` is already running, you can query it with Dolt
itself:

```sh
DOLT_CLI_PASSWORD="$DOLT_PASSWORD" dolt --host 127.0.0.1 --port 3306 --no-tls \
  --user "$DOLT_USER" --use-db dolt \
  sql -q "SHOW TABLES;"
```

## Validate the schema

Run the canonical validation against fresh disposable Dolt repositories:

```sh
npm run validate-schema
```

The command applies two sequences, each to its own fresh repository:

1. `schema/current/*.sql` then `schema/catalog/*.sql` (the fresh-install path)
2. `schema/history/*.sql` then `schema/migrations/*.sql` (the existing-database
   path)

The second sequence proves the preserved history still parses and applies, and
that the forward migrations apply cleanly on top of its end-state. Validation
fails on invalid DDL or ordering errors and confirms the `events` table exists.

Two more checks run in the gate, and can be run directly:

```sh
npm run schema:equivalence   # both paths produce the same structure
npm run schema:codegen       # regenerate prototype/src/store/generated/rows.ts
```

`npm run schema:codegen -- --check` compares instead of writing, as the gate
lane does. They run on Node from the repository root. None of these connect
to or mutate a long-running local Dolt SQL server.

## Forward migration workflow

For the current MVP, keep forward migrations as numbered SQL files in
`schema/migrations/` and fold each one into `schema/current/` (or
`schema/catalog/`) in the same change, so the two paths stay equivalent. Then
regenerate the row types with `npm run schema:codegen`.

If this becomes difficult to audit, the next step is a tiny DYFJ-native
migration ledger table that records applied migration ids and checksums. Do not
introduce an external migration framework before the repository needs that
weight.

## Why Dolt

Dolt gives MySQL-compatible SQL on top of git-like versioning — branches,
diffs, commits, time-travel. For a substrate that values an immutable record
alongside queryable working state, that combination is hard to replace with
anything else.
