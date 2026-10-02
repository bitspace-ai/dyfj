# DYFJ Core (Rust)

The Rust substrate for DYFJ. It grows downward as components prove out in the prototype layer and earn their way into the substrate.

A Cargo workspace with two members:

- `dyfj-core` — the schema tracer bullet: a small event read/write library plus a demo binary that round-trips one event through Dolt.
- `dyfj-repl` — the interactive REPL front-end. It owns the terminal and speaks the Workbench UDS protocol as a client, so the agent loop stays in `../prototype/`.

`core/Cargo.toml` is both the workspace root and the `dyfj-core` package, so paths that reference `core/` are unchanged.

## Why Rust here

The strict feedback loop that frustrates human iteration is *positive* feedback for agents. Compile-time correctness, explicit failure modes, and predictable performance matter most where the substrate lives. Layer 0 stance: Rust where its compile/build cycle does not interfere with prototyping; TypeScript stays in `../prototype/` for everything else.

## Build it

You don't need Rust pre-installed if you have [`rustup`](https://rustup.rs/) — `rust-toolchain.toml` will pull the right toolchain automatically.

```sh
cargo build
cargo run
```

`cargo build` builds both members. `cargo run -p dyfj-repl` starts the REPL against a running Workbench runtime, resolving the socket the way the runtime does: `DYFJ_SOCKET`, else `$XDG_RUNTIME_DIR/dyfj/workbench.sock`, else `~/.dyfj/run/workbench.sock`.

The REPL sends the same turn request as the TypeScript client: the chosen model and fast tier, the per-session paid opt-in, and the workspace when a turn starts a new session. Flags: `--model <slug>` (else `DYFJ_WORKBENCH_MODEL`, else the runtime's default), `--approve-paid`, `--fast`, `--session <id>` to resume a session (the id or the `workbench-<id>` slug `dyfj sessions` lists; anything else is refused at startup), and `--workspace <dir>` for a new session (else `DYFJ_WORKSPACE`, else the current directory; a resumed session keeps its own). The startup posture line names these choices when they differ from the runtime's defaults. Every turn ends with a receipt line: model, turn cost, running session cost, input and output tokens, prompt-cache reads and writes when the provider reported them, tool steps, and the route reason.

Commands are recognised only when typed alone on one line, so a pasted block that contains `/model` stays prompt text, and an unknown `/word` is sent as a prompt:

- `/model [slug] [--approve-paid] [--fast|--no-fast]` lists models grouped by route (unroutable rows marked) or switches to one, refusing unknown and unroutable slugs.
- `/fast [on|off]` toggles the fast speed tier on models that advertise it, checking the runtime's default model when none was chosen.
- `/session`, `/session list`, `/session switch <id>` show the current session, list recent ones, or resume one.
- `/friction <blocker|major|minor|paper-cut> [--escaped] <text>` posts a friction entry with the session, model, workspace name (never its path) and last command as context (`friction/post`), answering any approval the runtime asks for the write.
- `/idea mark <label>` and `/idea list` mark and list ideas for the current session.
- `/help` lists them; `/quit`, `/exit` or Ctrl-D leave. Ctrl-C while a command waits on the runtime abandons that command, as it cancels a turn.

External-runner (ACP) receipts are named rather than rendered; that route is deferred for daily use and stays in the TypeScript client.

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
