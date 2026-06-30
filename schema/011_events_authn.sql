-- DYFJ — Add authentication metadata to events
--
-- Security/auditability already records the acting principal and authz basis:
--
--   principal_id, principal_type  = who acted
--   authz_basis                   = why the action was permitted
--
-- This migration adds authentication metadata for how that same principal
-- identity was established. It deliberately does not add a second principal
-- identity field and does not add an authn_context JSON blob; structurally
-- important audit fields stay queryable as SQL primitives.
--
-- Credential material stays outside event rows. Store stable references only;
-- keep tokens, cookies, API keys, raw OAuth claims, raw JWTs, decoded
-- credential bodies, private key material, and other credential contents out of
-- these columns:
--
--   authn_issuer_ref   = identity issuer reference (local_os, github, google,
--                       kubernetes, runtime, workshop, etc.)
--   authn_session_ref  = stable auth/session reference, never a token
--   authn_evidence_ref = pointer to evidence, never raw credential material
--
-- Field usage:
--   authn_status           = authenticated / unauthenticated / unknown / not_applicable
--   authn_mechanism        = local_user, oauth, api_key, service_account,
--                            mcp_session, k8s_service_account, ssh_key, etc.
--   authn_issuer_ref       = identity issuer reference
--   authn_session_ref      = stable session/auth session reference
--   authn_authenticated_at = when identity was established
--   authn_expires_at       = when the authn assertion/session expires, if known
--   authn_evidence_ref     = pointer to authn evidence, not credential contents

ALTER TABLE events
  ADD COLUMN authn_status ENUM(
      'authenticated',
      'unauthenticated',
      'unknown',
      'not_applicable'
    ) NOT NULL DEFAULT 'unknown' AFTER authz_basis,
  ADD COLUMN authn_mechanism        VARCHAR(64)   NULL AFTER authn_status,
  ADD COLUMN authn_issuer_ref       VARCHAR(128)  NULL AFTER authn_mechanism,
  ADD COLUMN authn_session_ref      VARCHAR(256)  NULL AFTER authn_issuer_ref,
  ADD COLUMN authn_authenticated_at TIMESTAMP(6)  NULL AFTER authn_session_ref,
  ADD COLUMN authn_expires_at       TIMESTAMP(6)  NULL AFTER authn_authenticated_at,
  ADD COLUMN authn_evidence_ref     VARCHAR(512)  NULL AFTER authn_expires_at;
