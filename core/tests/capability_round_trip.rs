//! Tracer bullet integration test for the capability/discovery columns
//! introduced in `schema/010_events_capability.sql`. Mirrors
//! `schema_round_trip.rs` in shape — the same write/read/equality proof,
//! exercising a `capability_provide` event with the four new typed fields.
//! `capability_metadata` (JSON) is deferred — left at None until we wire
//! a JSON binding.
//!
//! Marked #[ignore] so plain `cargo test` stays fast and DB-free.
//! Run explicitly: `cargo test -- --ignored`.

use anyhow::{Context, Result};
use chrono::{DateTime, Duration, Utc};
use dyfj_core::events::{self, Event};
use sqlx::MySqlPool;

fn make_capability_provide_event() -> Event {
    let event_id = ulid::Ulid::new().to_string();
    let session_id = ulid::Ulid::new().to_string();
    let trace_id = format!("{:032x}", rand::random::<u128>());
    let span_id = format!("{:016x}", rand::random::<u64>());
    let now_micros = Utc::now().timestamp_micros();
    let created_at = DateTime::<Utc>::from_timestamp_micros(now_micros)
        .expect("current time must be representable as microseconds since epoch");
    let lease_expires_micros = now_micros
        + Duration::hours(1)
            .num_microseconds()
            .expect("one hour must fit in i64 microseconds");
    let lease_expires = DateTime::<Utc>::from_timestamp_micros(lease_expires_micros)
        .expect("lease expiry must be representable as microseconds since epoch");
    let lease_id = ulid::Ulid::new().to_string();

    Event {
        event_id,
        session_id,
        event_type: "capability_provide".to_string(),
        created_at,
        trace_id,
        span_id,
        parent_span_id: None,
        principal_id: "rook".to_string(),
        principal_type: "agent".to_string(),
        action: "advertise".to_string(),
        resource: "memory.search.semantic".to_string(),
        authz_basis: "test".to_string(),
        capability_name: Some("memory.search.semantic".to_string()),
        capability_version: Some("1.0.0".to_string()),
        capability_lease_id: Some(lease_id),
        capability_lease_expires: Some(lease_expires),
        capability_metadata: None,
    }
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires a running Dolt sql-server with the schema applied"]
async fn round_trip_capability_provide_event() -> Result<()> {
    let _ = dotenvy::dotenv();
    let database_url =
        std::env::var("DATABASE_URL").context("DATABASE_URL must be set for integration tests")?;
    let pool = MySqlPool::connect(&database_url)
        .await
        .with_context(|| format!("connect to {database_url}"))?;

    let event = make_capability_provide_event();

    events::write(&pool, &event)
        .await
        .context("events::write should accept a well-formed capability_provide event")?;

    let read_back = events::read_by_id(&pool, &event.event_id)
        .await
        .context("events::read_by_id should not error on an event that was just written")?
        .expect("the event we just wrote must be readable by id");

    assert_eq!(
        event, read_back,
        "round-trip must preserve every capability/discovery field exactly"
    );

    Ok(())
}
