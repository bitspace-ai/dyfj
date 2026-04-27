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

The first meaningful commit here is a tracer bullet (see `../notes/tracer-bullet.md`). Library + binary in a single crate: `src/lib.rs` will expose `events::write()` and `events::read_by_id()`; `src/main.rs` will be a thin demo that exercises them end-to-end against `../schema/001_events.sql`. That proves the schema-in-data-layer stance is real and gives the substrate something to build on.

After that, components get pulled into Rust as they stabilize in the prototype — most likely starting with extending the event/log API, then memory access, then policy/permission checks. There is no global port plan; each move is a separate decision.

## Layout

- `Cargo.toml` — crate metadata, edition 2024
- `rust-toolchain.toml` — pins the Rust toolchain channel for reproducibility
- `src/main.rs` — placeholder binary today; will be the tracer-bullet demo wrapper

`Cargo.lock` is tracked because DYFJ Project is source-published — anyone cloning gets a known-good resolved dependency tree. `target/` is gitignored.
