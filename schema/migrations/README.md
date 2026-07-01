# Forward Migrations

Place new schema changes here after updating the current baseline workflow.

Use numbered SQL files such as `001_add_example.sql`. The validator applies:

1. `schema/current/*.sql`
2. `schema/catalog/*.sql`
3. `schema/migrations/*.sql`

The historical replay files in `schema/history/` remain validation input, but
new work should not add files there unless reconstructing prior provenance.
