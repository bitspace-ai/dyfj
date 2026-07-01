-- DYFJ — Reflections Schema
-- Replaces: MEMORY/LEARNING/REFLECTIONS/algorithm-reflections.jsonl
--
-- Unlike memories and sessions, reflections are genuinely tabular data.
-- Every field maps to a column because the value is in aggregate queries:
-- pass rates over time, sentiment trends, budget compliance, capability gaps.
-- No freeform content — this is structured learning data.

CREATE TABLE IF NOT EXISTS reflections (
    -- Identity — use ULID/UUIDv7 for time-sortable inserts
    reflection_id   VARCHAR(64)   NOT NULL PRIMARY KEY,
    -- References sessions.slug — not a hard FK because reflections may
    -- outlive session records or reference sessions from other systems
    session_slug    VARCHAR(256)  NOT NULL,

    -- What was attempted
    -- Canonical effort levels — keep in sync with sessions.effort_level
    effort_level    ENUM('standard','extended','advanced','deep','comprehensive') NOT NULL,
    task_description VARCHAR(256) NOT NULL,

    -- How it went — the quantitative signal
    -- criteria_count may != passed + failed when criteria are deferred/skipped
    criteria_count  INT UNSIGNED  NOT NULL,
    criteria_passed INT UNSIGNED  NOT NULL,
    criteria_failed INT UNSIGNED  NOT NULL,
    -- Whether the session completed within the effort tier's time budget
    within_budget   BOOLEAN       NOT NULL,
    -- 1-10 estimate of user satisfaction from conversation tone (not a user rating)
    implied_sentiment TINYINT UNSIGNED NULL,

    -- What was learned — the qualitative signal
    -- Q1: what should I have done differently
    reflection_execution TEXT     NOT NULL,
    -- Q2: what would a smarter algorithm have done
    reflection_approach  TEXT     NOT NULL,
    -- Q3: what capabilities were missing
    reflection_gaps      TEXT     NOT NULL,

    -- No updated_at — reflections are append-only, immutable once written
    created_at      TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    -- Indexes — each is a prolly-tree in Dolt, so keep minimal
    INDEX idx_session     (session_slug),
    INDEX idx_effort      (effort_level, created_at)
);
