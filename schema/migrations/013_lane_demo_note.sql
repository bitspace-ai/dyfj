-- DELIBERATELY BROKEN DEMO (reverted in the next commit): adds a column in a
-- forward migration without folding it into schema/current/, so the
-- schema.equivalence lane must fail while schema.codegen passes.
ALTER TABLE events ADD COLUMN lane_demo_note VARCHAR(64) AFTER duration_ms;
