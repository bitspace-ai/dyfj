# Tracer Bullet — Schema-as-Source-of-Truth (Rust Core)

Status: design note, pre-implementation.
Location of the work: `core/`. This is the first meaningful Rust commit for DYFJ Project.

## Goal

Prove the Layer 0 stance "schema lives in the data layer, not in language types" end-to-end in Rust: write one well-formed event into Dolt against the canonical `schema/001_events.sql`, read it back, verify round-trip equality. If this works, we have the substrate foundation for everything downstream — Rust code reading and writing events into the same Dolt database the prototype uses, no language-side schema definition, no type-level source of truth.

## Scope

A Cargo crate in `core/` that ships **both a library and a binary demo**, source-published. DYFJ Project distributes source, not built artifacts — the library is what other Rust code can depend on; the binary is the demo that proves the library works end-to-end.

**Library (`src/lib.rs`):**

- `events::write()` — insert one well-formed event.
- `events::read_by_id()` — fetch one event by `event_id`.

These are the first two public functions of `dyfj-core`. They define the contract every later substrate consumer will use.

**Binary (`src/main.rs`):**

A thin demo wrapper that:

1. Connects to the local Dolt SQL server.
2. Generates one synthetic `session_start` event with all required schema fields populated.
3. Calls `events::write()`.
4. Calls `events::read_by_id()`.
5. Verifies field-by-field equality (or fails with a useful diff).
6. Prints the result; exits 0 on success, non-zero on failure.

`session_start` is chosen as the simplest event type — it requires only the identity + OTel + security trio, no model/tool/cost fields.

## Anti-scope

Deliberately not part of this commit:

- Multiple events, batching, or streaming.
- Other event types (`model_response`, `tool_call`, `error`, `session_end`).
- Any abstraction layer over the event schema beyond the two library functions named below.
- Runtime registry stub (separate Active Commitment).
- Cost-visibility surface (separate Active Commitment).
- Anything async beyond what sqlx requires.
- Evals — they belong on model-touching code, which this commit does not contain.

The point of naming these is to make scope creep visible. If the diff exceeds these lines, ask why.

## Decisions

### Crate: `sqlx` (with `mysql` and `runtime-tokio` features)

Idiomatic modern Rust for SQL access. Async-first, supports MySQL 8.0 (which Dolt speaks natively), enables compile-time query checking against a live database. The compile-time check is *exactly* the Layer 0 stance enforced at the language boundary — you cannot write a query that doesn't match what's in Dolt without the build failing.

Runner-up considered: `mysql_async` — simpler, no compile-time check, smaller dependency footprint. `sqlx` wins on stance alignment.

### Async runtime: `tokio`

Required by sqlx. Use `#[tokio::main(flavor = "current_thread")]` — a single-shot CLI binary doesn't benefit from work-stealing.

### Connection: `DATABASE_URL` environment variable, required

Standard Rust idiom; sqlx and the broader ecosystem expect this. The binary requires `DATABASE_URL` to be set — no hardcoded fallback in code. `dotenvy` loads `.env` at startup, so local dev is frictionless once `core/.env` exists. Convention documented in `core/.env.example`.

No default in code: documented credentials in source read as careless. Requiring explicit configuration costs one `cp .env.example .env`.

### Error handling: `anyhow` in `main.rs`, `thiserror` in `lib.rs`

`anyhow` is right for the binary's entry point — errors there are user-visible failures, no public-API contract to maintain. `thiserror` belongs in the library — its error types are part of the public API any future Rust consumer of `dyfj-core` will see. Same crate, two error styles, different files.

### ID generation: `ulid` crate

Schema specifies time-sortable IDs (ULID/UUIDv7) for Dolt prolly-tree insert performance. The `ulid` crate is the de facto choice in the Rust ecosystem for this.

## Testing strategy

Tests land with the code, not after it. Three layers:

- **Unit tests** in `src/lib.rs` via `#[cfg(test)] mod tests` — anything that can be tested without a live database (event-struct construction, parameter validation, ID generation). Fast; no network; runs in CI by default.
- **Integration test** at `tests/schema_round_trip.rs` — *this is the tracer bullet's actual proof.* Connects to a live Dolt, calls `events::write()`, calls `events::read_by_id()`, asserts field-by-field equality. Marked `#[ignore]` by default so `cargo test` stays fast in environments without Dolt; explicitly run with `cargo test -- --ignored` or in CI with Dolt provisioned.
- **Demo binary** at `src/main.rs` — exercises the same code path as the integration test, but human-readable (prints what happened). Useful for "kick the tires after a refactor" without needing to read test output.

The integration test is the source of truth for "does the tracer bullet work?" The binary is a UI on top of it. If the binary works but the test doesn't, something is wrong with the test setup; if the test works but the binary doesn't, something is wrong with the binary's I/O — not with the substrate logic.

## Success criterion

`cargo test -- --ignored` passes (with Dolt running and schema applied). `cargo run` prints:

```
inserted event: 01HX...
read back:      01HX...
match:          ok
```

Exit code 0. Field-by-field comparison: every required field that went in came back identical, nullable fields that were null stay null, default-populated fields (`created_at`) are populated and reasonable.

On any field mismatch: the test fails with a useful diff (and the binary, which calls the same path, exits non-zero with the same diff to stdout).

## Open questions to resolve before / during coding

- **`.sqlx` cache vs. live `DATABASE_URL` at compile time.** sqlx's compile-time query check requires either a live `DATABASE_URL` during `cargo build` OR a pre-prepared `.sqlx/` cache committed to the repo. The cache is the more portable choice for a public repo — someone cloning without Dolt running can still `cargo build`. Verify the `cargo sqlx prepare` workflow before locking it in. If cache turns out to be friction, fall back to live-DB compile mode and document the requirement.
- **Schema header label drift.** `schema/001_events.sql` opens with "DYFJ Workbench — Canonical Event Schema" — a stale label from the pre-rename era. One-line fix; separate commit; not blocking this work.

## What this seeds for next

- **The first blog post.** "I wrote a 200-line Rust tracer bullet for my AI stack" — captures the Layer 0 stance in working code, with the `.sqlx`-cache choice and any surprises as the actual content.
- **The second meaningful Rust commit.** *Extend* the library — additional event types beyond `session_start`, batched writes, query helpers, or the first error-recovery code path. Whatever the next pain point is when Workbench (or any future consumer) actually starts using `dyfj-core`. The library exists from this commit; subsequent commits grow it.
