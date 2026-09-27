# Forward Migrations

Forward migrations bring an existing database, created from `schema/history/`
before the current baseline cut, up to the current structure. A fresh install
applies `schema/current/` then `schema/catalog/` and never applies these files
on top of it (see [`../README.md`](../README.md), "Apply the schema").

Use numbered SQL files such as `013_add_example.sql`. Write each migration
against the shape it upgrades from, and fold its effect into `schema/current/`
(or `schema/catalog/`) in the same change. The gate checks both paths:

1. `schema/current/*.sql` then `schema/catalog/*.sql` (fresh install) and
   `schema/history/*.sql` then `schema/migrations/*.sql` (existing database)
   must each apply cleanly (`deno task validate-schema`).
2. The two must produce the same structure (`schema.equivalence`).
3. The generated row types must match the DDL (`schema.codegen`; regenerate
   with `deno task schema:codegen`).

The historical replay files in `schema/history/` remain validation input, but
new work should not add files there unless reconstructing prior provenance.

The Workbench engine refuses to start against a reachable database that lacks
a canonical column, naming the missing columns; apply the migrations here to
fix that.

`005_events_external_agent_runner.sql` adds the typed event fields used by the
local ACP-client runner foundation.

`007_events_otel_context.sql` adds minimized OpenTelemetry trace flags, state,
span kind, and remote-parent evidence. Raw propagation envelopes are not
stored.
