-- DELIBERATELY BROKEN DEMO (reverted in the next commits): adds a column to
-- the DDL and its migration without regenerating the row types, so the
-- schema.codegen lane must fail.
ALTER TABLE events ADD COLUMN lane_demo_note VARCHAR(64) AFTER duration_ms;
