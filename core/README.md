# DYFJ Core (Rust)

The Rust substrate for DYFJ. Today this is a placeholder binary. Tomorrow it grows downward as components prove out in the prototype layer and earn their way into the substrate.

## Why Rust here

The strict feedback loop that frustrates human iteration is *positive* feedback for agents. Compile-time correctness, explicit failure modes, and predictable performance matter most where the substrate lives. Layer 0 stance: Rust where its compile/build cycle does not interfere with prototyping; TypeScript stays in `../prototype/` for everything else.

## Build it

You don't need Rust pre-installed if you have [`rustup`](https://rustup.rs/) — `rust-toolchain.toml` will pull the right toolchain automatically.

```sh
cargo build
cargo run
```

Today that prints a placeholder line. That's accurate; the real work hasn't been written yet.

## What's next

The first meaningful commit here will be a tracer bullet: a single binary that writes one well-formed event into Dolt (per `../schema/001_events.sql`), reads it back, and verifies the round-trip through the canonical schema. That proves the schema-in-data-layer stance is real and gives us a structural foundation to build on.

After that, components get pulled into Rust as they stabilize in the prototype — most likely starting with the event/log writer, then memory access, then policy/permission checks. There is no global port plan; each move is a separate decision.

## Layout

- `Cargo.toml` — crate metadata, edition 2024
- `rust-toolchain.toml` — pins the Rust toolchain channel for reproducibility
- `src/main.rs` — placeholder binary

`Cargo.lock` is tracked (this is a binary crate; the lockfile is part of the reproducibility story). `target/` is gitignored.
