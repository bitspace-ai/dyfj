//! Event read/write against the canonical Dolt schema.
//!
//! Mirrors `schema/001_events.sql` for the fields exercised by the
//! tracer bullet (the identity + OTel + security trio plus event_type
//! and created_at). Other schema fields — model/provider context,
//! token usage, content, tool fields, thinking, duration — will be
//! added as they become relevant; not all events use all fields.
//!
//! Queries use `sqlx::query!` / `sqlx::query_as!` macros, which are
//! checked at compile time against the schema in `.sqlx/` (or against
//! a live `DATABASE_URL` if the cache is missing). That makes any
//! drift between the Rust code and the canonical schema a *build*
//! failure, not a runtime one — the schema-in-data-layer stance
//! enforced at the language boundary.

use chrono::{DateTime, Utc};
use sqlx::MySqlPool;

use crate::error::Result;

/// One row of the `events` table, restricted to the subset of fields
/// the tracer bullet exercises.
#[derive(Debug, Clone, PartialEq)]
pub struct Event {
    pub event_id: String,
    pub session_id: String,
    pub event_type: String,
    pub created_at: DateTime<Utc>,
    pub trace_id: String,
    pub span_id: String,
    pub parent_span_id: Option<String>,
    pub principal_id: String,
    pub principal_type: String,
    pub action: String,
    pub resource: String,
    pub authz_basis: String,
}

/// Insert one event into the `events` table.
pub async fn write(pool: &MySqlPool, event: &Event) -> Result<()> {
    sqlx::query!(
        r#"
        INSERT INTO events (
            event_id, session_id, event_type, created_at,
            trace_id, span_id, parent_span_id,
            principal_id, principal_type, action, resource, authz_basis
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
        event.event_id,
        event.session_id,
        event.event_type,
        event.created_at,
        event.trace_id,
        event.span_id,
        event.parent_span_id,
        event.principal_id,
        event.principal_type,
        event.action,
        event.resource,
        event.authz_basis,
    )
    .execute(pool)
    .await?;

    Ok(())
}

/// Look up one event by its primary key. Returns `None` if no row matches —
/// this is a successful lookup that found nothing, not an error.
pub async fn read_by_id(pool: &MySqlPool, event_id: &str) -> Result<Option<Event>> {
    let row = sqlx::query!(
        r#"
        SELECT
            event_id, session_id, event_type, created_at,
            trace_id, span_id, parent_span_id,
            principal_id, principal_type, action, resource, authz_basis
        FROM events
        WHERE event_id = ?
        "#,
        event_id,
    )
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|r| Event {
        event_id: r.event_id,
        session_id: r.session_id,
        event_type: r.event_type,
        created_at: r.created_at,
        trace_id: r.trace_id,
        span_id: r.span_id,
        parent_span_id: r.parent_span_id,
        principal_id: r.principal_id,
        principal_type: r.principal_type,
        action: r.action,
        resource: r.resource,
        authz_basis: r.authz_basis,
    }))
}
