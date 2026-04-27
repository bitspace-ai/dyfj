//! DYFJ Core — Rust substrate for a sovereign personal AI stack.
//!
//! This is the library half of the crate. The binary in `src/main.rs`
//! is a demo wrapper; real consumers depend on the library directly.

pub mod events;
pub mod error;

pub use error::Error;
