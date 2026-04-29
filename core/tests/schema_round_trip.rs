//! Tracer bullet integration test: prove a session_start event survives a
//! Dolt round-trip with field-by-field equality.
//!
//! Marked #[ignore] so plain `cargo test` stays fast and DB-free.
//! Run explicitly: `cargo test -- --ignored`.

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use dyfj_core::events::{self, Event};
use sqlx::MySqlPool;

fn make_session_start_event() -> Event {
    let event_id = ulid::Ulid::new().to_string();
    let session_id = ulid::Ulid::new().to_string();
    let trace_id = format!("{:032x}", rand::random::<u128>());
    let span_id = format!("{:016x}", rand::random::<u64>());
    let created_at = DateTime::<Utc>::from_timestamp_micros(Utc::now().timestamp_micros())
        .expect("current time must be representable as microseconds since epoch");

    Event {
        event_id,
        session_id,
        event_type: "session_start".to_string(),
        created_at,
        trace_id,
        span_id,
        parent_span_id: None,
        principal_id: "tracer-bullet".to_string(),
        principal_type: "agent".to_string(),
        action: "session_start".to_string(),
        resource: "core/tests/schema_round_trip.rs".to_string(),
        authz_basis: "test".to_string(),
        capability_name: None,
        capability_version: None,
        capability_lease_id: None,
        capability_lease_expires: None,
        capability_metadata: None,
    }
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires a running Dolt sql-server with the schema applied"]
async fn round_trip_session_start_event() -> Result<()> {
    let _ = dotenvy::dotenv();
    let database_url =
        std::env::var("DATABASE_URL").context("DATABASE_URL must be set for integration tests")?;
    let pool = MySqlPool::connect(&database_url)
        .await
        .with_context(|| format!("connect to {database_url}"))?;

    let event = make_session_start_event();

    events::write(&pool, &event)
        .await
        .context("events::write should accept a well-formed session_start event")?;

    let read_back = events::read_by_id(&pool, &event.event_id)
        .await
        .context("events::read_by_id should not error on an event that was just written")?
        .expect("the event we just wrote must be readable by id");

    assert_eq!(
        event, read_back,
        "round-trip must preserve every field exactly"
    );

    Ok(())
}
