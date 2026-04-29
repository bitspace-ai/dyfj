//! Tracer-bullet demo: writes one well-formed `session_start` event
//! into Dolt, reads it back by id, and verifies field-by-field equality.
//!
//! Same code path as the integration test (`tests/schema_round_trip.rs`);
//! this binary exists so the round-trip is observable by a human running
//! `cargo run` rather than only by `cargo test -- --ignored`.

use anyhow::{Context, Result, bail};
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
        resource: "core/src/main.rs".to_string(),
        authz_basis: "demo".to_string(),
        capability_name: None,
        capability_version: None,
        capability_lease_id: None,
        capability_lease_expires: None,
        capability_metadata: None,
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let _ = dotenvy::dotenv();

    let database_url = std::env::var("DATABASE_URL").context(
        "DATABASE_URL is not set. For local development, copy core/.env.example to \
         core/.env (or export DATABASE_URL directly).",
    )?;

    let pool = MySqlPool::connect(&database_url)
        .await
        .with_context(|| format!("failed to connect to {database_url}"))?;

    let event = make_session_start_event();
    println!("inserting event:    {}", event.event_id);

    events::write(&pool, &event)
        .await
        .context("failed to write event")?;

    let read_back = events::read_by_id(&pool, &event.event_id)
        .await
        .context("failed to read event back")?
        .context("event we just wrote was not readable by id")?;
    println!("read back:          {}", read_back.event_id);

    if event != read_back {
        bail!("round-trip mismatch: event written != event read");
    }
    println!("match:              ok");

    Ok(())
}
