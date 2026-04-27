-- DYFJ Workbench — Canonical Event Schema
-- Design: OTel correlation and security/auditability are structural requirements, not plugins.
--
-- Design principles:
--   1. Schema lives with the data, not in a language. This DDL IS the contract.
--   2. OTel and security fields are NOT NULL (except parent_span_id for root spans).
--   3. Stored events represent completed operations, not streaming deltas.
--   4. Every field is a SQL primitive — no JSON blobs for required fields.
--   5. Compatible with Dolt (MySQL 8.0 dialect).
--
-- Stored event taxonomy (from first principles analysis):
--   - model_response: a completed LLM call (text + optional thinking + usage)
--   - tool_call:      a tool invocation with result
--   - error:          a failed operation
--   - session_start:  beginning of a user interaction session
--   - session_end:    end of a session (normal or abnormal)

CREATE TABLE IF NOT EXISTS events (
    -- Identity — use time-sortable IDs (ULID/UUIDv7) for Dolt prolly-tree insert perf
    event_id        VARCHAR(64)   NOT NULL PRIMARY KEY,
    session_id      VARCHAR(64)   NOT NULL,
    event_type      ENUM('model_response','tool_call','error','session_start','session_end') NOT NULL,
    -- Microsecond precision — matches OTel span timestamp granularity
    created_at      TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    -- OTel correlation (W3C trace context compatible)
    -- trace_id:       one user request through the full agent chain
    -- span_id:        one discrete operation (model call, tool use, discovery lookup)
    -- parent_span_id: what spawned this operation (NULL for root spans)
    trace_id        VARCHAR(64)   NOT NULL,
    span_id         VARCHAR(32)   NOT NULL,
    parent_span_id  VARCHAR(32)   NULL,

    -- Security / auditability
    -- principal_id:   who performed this action (human, agent, or service identifier)
    -- principal_type: what kind of entity
    -- action:         what they did (invoke, read, write, discover)
    -- resource:       to what (model name, capability, data path)
    -- authz_basis:    mechanism by which this was permitted (e.g. user_consent, capability_grant, policy:name)
    principal_id    VARCHAR(128)  NOT NULL,
    principal_type  ENUM('human','agent','service') NOT NULL,
    action          VARCHAR(64)   NOT NULL,
    resource        VARCHAR(256)  NOT NULL,
    authz_basis     VARCHAR(256)  NOT NULL,

    -- Model/provider context (populated for model_response and error events)
    model_id        VARCHAR(128)  NULL,
    provider        VARCHAR(64)   NULL,
    api             VARCHAR(64)   NULL,

    -- Token usage (populated for model_response events)
    tokens_input    INT UNSIGNED  NULL,
    tokens_output   INT UNSIGNED  NULL,
    tokens_cache_read  INT UNSIGNED NULL,
    tokens_cache_write INT UNSIGNED NULL,
    -- DECIMAL(10,6) — sub-cent granularity for per-call API costs (max $9999.999999)
    cost_total      DECIMAL(10,6) NULL,

    -- Content (populated per event_type)
    -- model_response: the response text
    -- tool_call: tool name in tool_name, arguments as JSON in content, result in tool_result
    -- error: error message
    -- session_start/end: NULL or descriptive text
    -- TEXT (64KB) sufficient for POC; upgrade to MEDIUMTEXT if responses exceed 64KB
    content         TEXT          NULL,
    stop_reason     ENUM('stop','length','tool_use','error','aborted') NULL,

    -- Tool call fields (populated for tool_call events)
    tool_name       VARCHAR(128)  NULL,
    tool_call_id    VARCHAR(128)  NULL,
    tool_arguments  JSON          NULL,
    tool_result     TEXT          NULL,
    tool_is_error   BOOLEAN       NULL,

    -- Thinking content (populated when model emits reasoning)
    thinking        TEXT          NULL,

    -- Duration of this operation in milliseconds
    duration_ms     INT UNSIGNED  NULL,

    -- Indexes for common query patterns
    INDEX idx_session     (session_id, created_at),
    INDEX idx_trace       (trace_id, span_id),
    INDEX idx_principal   (principal_id, principal_type, created_at),
    INDEX idx_event_type  (event_type, created_at),
    INDEX idx_model       (model_id, created_at)
);
