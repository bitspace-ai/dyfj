# DYFJ Core (Rust)

The Rust substrate for DYFJ. Today it contains the first schema tracer bullet: a small event read/write library plus a demo binary that round-trips one event through Dolt. It grows downward as components prove out in the prototype layer and earn their way into the substrate.

## Why Rust here

The strict feedback loop that frustrates human iteration is *positive* feedback for agents. Compile-time correctness, explicit failure modes, and predictable performance matter most where the substrate lives. Layer 0 stance: Rust where its compile/build cycle does not interfere with prototyping; TypeScript stays in `../prototype/` for everything else.

## Build it

You don't need Rust pre-installed if you have [`rustup`](https://rustup.rs/) — `rust-toolchain.toml` will pull the right toolchain automatically.

```sh
cargo build
cargo run
```

`cargo run` requires `DATABASE_URL` and a running Dolt SQL server. It inserts one `session_start` event, reads it back, and prints a match result. The ignored integration tests exercise the same live-Dolt path:

```sh
cargo test -- --ignored
```

For DB-free compile/test against the committed `.sqlx/` query cache:

```sh
SQLX_OFFLINE=true cargo test
```

## What's next

The first meaningful commit here has landed (see `../notes/tracer-bullet.md`). Future Rust work should extend from stabilized needs in the prototype, most likely additional event types, batched writes, query helpers, memory access, or policy/permission checks. There is no global port plan; each move is a separate decision.

## Layout

- `Cargo.toml` — crate metadata, edition 2024
- `rust-toolchain.toml` — pins the Rust toolchain channel for reproducibility
- `src/events.rs` — minimal event read/write API over the canonical Dolt schema
- `src/main.rs` — tracer-bullet demo wrapper
- `tests/` — ignored live-Dolt integration tests

`Cargo.lock` is tracked because DYFJ Project is source-published — anyone cloning gets a known-good resolved dependency tree. `target/` is gitignored.
