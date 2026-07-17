-- DYFJ current structural baseline.
--
-- This file is the readable current schema for a fresh DYFJ Dolt database.
-- Historical replay files live in schema/history/ and remain validation input,
-- but new readers should start here.

CREATE TABLE events (
    event_id                  VARCHAR(64)   NOT NULL PRIMARY KEY,
    session_id                VARCHAR(64)   NOT NULL,
    event_type                ENUM(
        'model_response',
        'tool_call',
        'error',
        'session_start',
        'session_end',
        'model_selected',
        'budget_summary',
        'context_compressed'
    ) NOT NULL,
    created_at                TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    trace_id                  VARCHAR(64)   NOT NULL,
    span_id                   VARCHAR(32)   NOT NULL,
    parent_span_id            VARCHAR(32),

    principal_id              VARCHAR(128)  NOT NULL,
    principal_type            ENUM('human', 'agent', 'service') NOT NULL,
    action                    VARCHAR(64)   NOT NULL,
    resource                  VARCHAR(256)  NOT NULL,
    authz_basis               VARCHAR(256)  NOT NULL,

    authn_status              ENUM(
        'authenticated',
        'unauthenticated',
        'unknown',
        'not_applicable'
    ) NOT NULL DEFAULT 'unknown',
    authn_mechanism           VARCHAR(64),
    authn_issuer_ref          VARCHAR(128),
    authn_session_ref         VARCHAR(256),
    authn_authenticated_at    TIMESTAMP(6),
    authn_expires_at          TIMESTAMP(6),
    authn_evidence_ref        VARCHAR(512),

    model_id                  VARCHAR(128),
    provider                  VARCHAR(64),
    api                       VARCHAR(64),

    tokens_input              INT UNSIGNED,
    tokens_output             INT UNSIGNED,
    tokens_cache_read         INT UNSIGNED,
    tokens_cache_write        INT UNSIGNED,
    cost_total                DECIMAL(10, 6),

    content                   TEXT,
    stop_reason               ENUM('stop', 'length', 'tool_use', 'error', 'aborted'),

    tool_name                 VARCHAR(128),
    tool_call_id              VARCHAR(128),
    tool_arguments            JSON,
    tool_result               TEXT,
    tool_is_error             BOOLEAN,

    thinking                  TEXT,
    duration_ms               INT UNSIGNED,

    INDEX idx_session (session_id, created_at),
    INDEX idx_event_type (event_type, created_at),
    INDEX idx_model (model_id, created_at),
    INDEX idx_principal (principal_id, principal_type, created_at),
    INDEX idx_trace (trace_id, span_id)
);

CREATE TABLE memories (
    memory_id     VARCHAR(64)  NOT NULL PRIMARY KEY,
    slug          VARCHAR(128) NOT NULL UNIQUE,
    type          ENUM('user', 'feedback', 'environment', 'project', 'reference') NOT NULL,
    visibility    ENUM('private', 'shareable', 'client_safe', 'public') NOT NULL DEFAULT 'private',
    inject        ENUM('always', 'index', 'never') NOT NULL DEFAULT 'index',
    name          VARCHAR(256) NOT NULL,
    description   TEXT         NOT NULL,
    content       TEXT         NOT NULL,
    created_at    TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at    TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                              ON UPDATE CURRENT_TIMESTAMP(6),

    INDEX idx_type (type, updated_at),
    INDEX idx_visibility (visibility, type),
    INDEX idx_inject (inject, visibility)
);

CREATE TABLE sessions (
    session_id        VARCHAR(64)  NOT NULL PRIMARY KEY,
    slug              VARCHAR(256) NOT NULL UNIQUE,
    session_name      VARCHAR(128),
    external_id       VARCHAR(128),
    project           VARCHAR(128),
    workspace         VARCHAR(1024),
    task_description  VARCHAR(256) NOT NULL,
    effort_level      ENUM('standard', 'extended', 'advanced', 'deep', 'comprehensive'),
    status            ENUM('active', 'completed') NOT NULL DEFAULT 'active',
    progress_done     INT UNSIGNED NOT NULL DEFAULT 0,
    progress_total    INT UNSIGNED NOT NULL DEFAULT 0,
    mode              ENUM('interactive', 'loop') NOT NULL DEFAULT 'interactive',
    iteration         INT UNSIGNED,
    content           TEXT,
    created_at        TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at        TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                  ON UPDATE CURRENT_TIMESTAMP(6),

    INDEX idx_status (status, updated_at),
    INDEX idx_project (project, updated_at)
);

CREATE TABLE models (
    slug               VARCHAR(128)   NOT NULL PRIMARY KEY,
    display_name       VARCHAR(256)   NOT NULL,
    provider           VARCHAR(64)    NOT NULL,
    api                VARCHAR(64)    NOT NULL,
    base_url           VARCHAR(512),
    tier               TINYINT UNSIGNED NOT NULL,
    context_window     INT UNSIGNED   NOT NULL,
    max_output_tokens  INT UNSIGNED   NOT NULL,
    cost_input         DECIMAL(12, 6) NOT NULL DEFAULT 0,
    cost_output        DECIMAL(12, 6) NOT NULL DEFAULT 0,
    cost_cache_read    DECIMAL(12, 6) NOT NULL DEFAULT 0,
    cost_cache_write   DECIMAL(12, 6) NOT NULL DEFAULT 0,
    reasoning          BOOLEAN        NOT NULL DEFAULT FALSE,
    capabilities       JSON           NOT NULL,
    active             BOOLEAN        NOT NULL DEFAULT TRUE,
    created_at         TIMESTAMP(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at         TIMESTAMP(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                      ON UPDATE CURRENT_TIMESTAMP(6),

    INDEX idx_tier (tier, active)
);

CREATE TABLE prompts (
    slug          VARCHAR(128)  NOT NULL PRIMARY KEY,
    display_name  VARCHAR(256)  NOT NULL,
    kind          VARCHAR(64)   NOT NULL,
    content       TEXT          NOT NULL,
    position      INT           NOT NULL DEFAULT 0,
    active        BOOLEAN       NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at    TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                ON UPDATE CURRENT_TIMESTAMP(6),

    INDEX idx_kind (kind, active, position)
);
