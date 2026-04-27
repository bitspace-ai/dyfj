// SPIKE: smallest sqlx + Dolt round-trip. Replaced once the tracer
// bullet's library + integration test land. Throwaway.

use anyhow::{Context, Result};
use sqlx::MySqlPool;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    // Loads .env if present; succeeds silently otherwise.
    let _ = dotenvy::dotenv();

    let database_url = std::env::var("DATABASE_URL").context(
        "DATABASE_URL is not set. For local development, copy core/.env.example to \
         core/.env (or export DATABASE_URL directly).",
    )?;

    let pool = MySqlPool::connect(&database_url)
        .await
        .with_context(|| format!("failed to connect to {database_url}"))?;

    let row: (i64,) = sqlx::query_as("SELECT 1")
        .fetch_one(&pool)
        .await
        .context("SELECT 1 failed")?;

    println!("dolt connection works. SELECT 1 returned {}", row.0);
    Ok(())
}
