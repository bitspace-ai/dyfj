-- DYFJ — Authentication evidence for external-agent turns.
--
-- Caller authentication remains in authn_* columns. These fields instead
-- distinguish the profile's route classification from the authentication type
-- reported by the adapter before session creation.

ALTER TABLE events
  ADD COLUMN runner_route_source ENUM('profile_declared', 'agent_auth_status') NULL AFTER runner_evidence_scope,
  ADD COLUMN runner_auth_type ENUM('chat-gpt', 'api-key', 'gateway', 'unauthenticated') NULL AFTER runner_route_source;
