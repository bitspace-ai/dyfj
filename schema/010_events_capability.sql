-- DYFJ — Add capability/discovery events
--
-- Day-1 schema commitment from README §10 and §1 inter-agent contracts:
-- the event log carries capability/discovery metadata structurally, so the
-- runtime registry (deferred Day-1) can be derived from the log later
-- without retrofitting.
--
-- Four new event_type values represent the bilateral-discovery speech acts
-- (Jini-shaped — lookup, leasing, capability/need matching):
--
--   capability_provide  — principal advertises a capability, optionally with a lease window
--   capability_require  — principal declares a need, optionally with a lease window
--   capability_match    — registry binds a `require` to a `provide` (lease_id references the provide event_id)
--   capability_release  — provider or consumer ends the lease (lease_id references the originating provide/require)
--
-- Field usage for capability_* events:
--   capability_name           = the capability identifier (see naming convention below)
--   capability_version        = semver string or NULL ("1.2.0", "^1.2", NULL)
--   capability_lease_id       = ULID — on provide/require, identifies this lease;
--                               on match/release, references the originating provide/require event_id
--   capability_lease_expires  = NULL means no expiry; otherwise the wall-clock expiry of the advertisement/request
--   capability_metadata       = JSON escape hatch — parameter schemas, constraints, regions,
--                               cost ceilings, trust requirements, anything not yet typed
--   principal_id, principal_type, action, resource, authz_basis  — required as on every event
--
-- Capability naming convention (Day-1, document-now-cheap):
--   Dotted hierarchy. Lowercase. Segments separated by `.`. No leading/trailing dot.
--   Examples:
--     ui.render.slider
--     ui.render.report.bar-chart
--     model.inference.tier-2
--     model.inference.tier-2.openai.gpt-4o
--     memory.search.semantic
--     storage.kv.local
--   Convention buys prefix-matching queries ("anyone who provides under model.inference.*")
--   without committing to a formal capability registry today. A registry table can be
--   added later as a separate migration if the folksonomy stops scaling.
--
-- Anti-scope (deliberately not in this migration):
--   - Capability registry table (separate migration if/when needed)
--   - Trust/policy on who is allowed to advertise what (Layer 2 policy engine concern)
--   - Federation across registries (future question)
--   - Capability-name validation in the schema (kept out so the convention can evolve)

ALTER TABLE events
  MODIFY COLUMN event_type
    ENUM(
      'model_response',
      'tool_call',
      'error',
      'session_start',
      'session_end',
      'model_selected',
      'capability_provide',
      'capability_require',
      'capability_match',
      'capability_release'
    )
    NOT NULL;

ALTER TABLE events
  ADD COLUMN capability_name          VARCHAR(255)  NULL,
  ADD COLUMN capability_version       VARCHAR(64)   NULL,
  ADD COLUMN capability_lease_id      VARCHAR(26)   NULL,
  ADD COLUMN capability_lease_expires TIMESTAMP(6)  NULL,
  ADD COLUMN capability_metadata      JSON          NULL;

-- Registry's primary lookup: "who currently provides capability X?"
-- WHERE capability_name = ? AND event_type = 'capability_provide'
--       AND (capability_lease_expires IS NULL OR capability_lease_expires > NOW(6))
ALTER TABLE events
  ADD INDEX idx_capability_name (capability_name, event_type, capability_lease_expires);

-- Lease-binding lookup: walk from a match/release back to its originating provide/require
ALTER TABLE events
  ADD INDEX idx_capability_lease (capability_lease_id);
