//! Event read/write against the canonical Dolt schema.
//!
//! Mirrors `schema/001_events.sql` for the fields exercised by the
//! tracer bullet (the identity + OTel + security trio plus event_type
//! and created_at). Other schema fields — model/provider context,
//! token usage, content, tool fields, thinking, duration — will be
//! added as they become relevant; not all events use all fields.

use chrono::{DateTime, Utc};
use sqlx::MySqlPool;

use crate::error::Result;

/// One row of the `events` table, restricted to the subset of fields
/// the tracer bullet exercises.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow)]
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
    sqlx::query(
        r#"
        INSERT INTO events (
            event_id, session_id, event_type, created_at,
            trace_id, span_id, parent_span_id,
            principal_id, principal_type, action, resource, authz_basis
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&event.event_id)
    .bind(&event.session_id)
    .bind(&event.event_type)
    .bind(event.created_at)
    .bind(&event.trace_id)
    .bind(&event.span_id)
    .bind(&event.parent_span_id)
    .bind(&event.principal_id)
    .bind(&event.principal_type)
    .bind(&event.action)
    .bind(&event.resource)
    .bind(&event.authz_basis)
    .execute(pool)
    .await?;

    Ok(())
}

/// Look up one event by its primary key. Returns `None` if no row matches —
/// this is a successful lookup that found nothing, not an error.
pub async fn read_by_id(pool: &MySqlPool, event_id: &str) -> Result<Option<Event>> {
    let row = sqlx::query_as::<_, Event>(
        r#"
        SELECT
            event_id, session_id, event_type, created_at,
            trace_id, span_id, parent_span_id,
            principal_id, principal_type, action, resource, authz_basis
        FROM events
        WHERE event_id = ?
        "#,
    )
    .bind(event_id)
    .fetch_optional(pool)
    .await?;

    Ok(row)
}
