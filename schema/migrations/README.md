# Forward Migrations

Place new schema changes here after updating the current baseline workflow.

Use numbered SQL files such as `001_add_example.sql`. Write each migration
against the pre-baseline shape it upgrades from. The validator applies two
sequences:

1. `schema/current/*.sql` then `schema/catalog/*.sql` (the fresh-install path)
2. `schema/history/*.sql` then `schema/migrations/*.sql` (the upgrade path:
   forward migrations must apply cleanly on top of the historical replay
   end-state)

The historical replay files in `schema/history/` remain validation input, but
new work should not add files there unless reconstructing prior provenance.

History replay is not an upgrade path. When a live database needs to move from
an older shape to the current baseline, add a forward migration here or perform
an explicit operator-reviewed migration outside the repository.
