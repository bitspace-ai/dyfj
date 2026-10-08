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

The REPL sends the same turn request as the TypeScript client: the chosen model and fast tier, the per-session paid opt-in, and the workspace when a turn starts a new session. Flags: `--model <slug>` (else `DYFJ_WORKBENCH_MODEL`, else the runtime's default), `--approve-paid`, `--fast`, `--session <id>` to resume a session (the id or the `workbench-<id>` slug `dyfj sessions` lists; anything else is refused at startup), and `--workspace <dir>` for a new session (else `DYFJ_WORKSPACE`, else the current directory; a resumed session keeps its own). A resumed session also keeps its model: `--session` reads the model the session last ran on from `sessions/inspect` to check and announce it, and leaves the routing to the runtime, which runs every turn that names no model on the session's recorded one and reports the route as `session_model`; `--model` names another and wins (`DYFJ_WORKBENCH_MODEL` is a default and does not override it). The startup posture line names these choices when they differ from the runtime's defaults, marks a restored model `restored from session`, and says `no recorded model for this session` when a resumed session has none, in which case it runs on the default as before. Every turn ends with a receipt line: model, turn cost, running session cost, input and output tokens, prompt-cache reads and writes when the provider reported them, tool steps, and the route reason.

A `--model` the runtime's catalog does not have, or cannot route because it is unpriced, is refused at launch with the available models listed, before the first prompt. A resumed session's recorded model is checked the same way: one that has left the catalog, been deactivated or lost its pricing is refused, with the available models and a pointer to `--model`, never silently replaced. A bare interactive `dyfj` starts this REPL when the binary is built (`cargo build --release -p dyfj-repl`); see the root README's "Build the core" for how the launcher picks it.

Commands are recognised only when typed alone on one line, so a pasted block that contains `/model` stays prompt text, and an unknown `/word` is sent as a prompt:

- `/model [slug] [--approve-paid] [--fast|--no-fast]` lists models grouped by route (unroutable rows marked) or switches to one, refusing unknown and unroutable slugs.
- `/fast [on|off]` toggles the fast speed tier on models that advertise it, checking the runtime's default model when none was chosen.
- `/session`, `/session list`, `/session switch <id>` show the current session, list recent ones, or resume one. A switch routes to the target session's recorded model, or with none recorded to the configured default, never to a model chosen with `/model` for the previous session, and prints the posture; a target whose recorded model is no longer routable, or that cannot be inspected, is not switched to. `/model` inside a session changes the model the next turn runs on, and that turn records it.
- `/friction <blocker|major|minor|paper-cut> [--escaped] <text>` posts a friction entry with the session, model, workspace name (never its path) and last command as context (`friction/post`), answering any approval the runtime asks for the write.
- `/idea mark <label>` and `/idea list` mark and list ideas for the current session.
- `/help` lists them; `/quit`, `/exit` or Ctrl-D leave. Ctrl-C while a read-only command waits on the runtime abandons that command, as it cancels a turn. The two writes wait instead: during `/friction` it denies any approval the post then asks for and waits for the runtime to settle it, so the abandoned write cannot be approved later, and `/idea mark` waits for the runtime to record the idea, so a retry cannot record it twice. `/friction`'s context names the previous slash command only when no turn came between them.

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
