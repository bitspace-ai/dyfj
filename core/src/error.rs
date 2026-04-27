//! Library-level error types.
//!
//! `thiserror` here (rather than `anyhow`) because these errors are part of
//! the public API. Callers need to be able to match on variants, not just
//! print them.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
}

pub type Result<T> = std::result::Result<T, Error>;
