-- Bind durable native sessions to their restart-stable execution profile.
ALTER TABLE events ADD COLUMN runner_resume_digest VARCHAR(64) NULL AFTER runner_external_session_id;
