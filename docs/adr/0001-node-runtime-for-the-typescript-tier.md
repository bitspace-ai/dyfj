# ADR-0001: Node.js LTS replaces Deno as the runtime of the TypeScript tier

- Status: accepted (2026-10-10)
- Decision log: D32 in `specs/README.md`
- Tracker: BIT-592

## Context

The TypeScript prototype under `prototype/` has run on Deno since the repository
began. Deno plays three separable roles there:

1. Interpreter and host API: `Deno.*` calls for files, processes, Unix sockets,
   DNS, signals and the terminal. In runtime source these are few and already
   sit behind ports (`Env`, `ProcessSpawner`, `DnsResolver`, the UDS transport).
2. Test runner and sanitizers: `Deno.test`, `@std/assert`, `@std/testing`,
   and the op and resource sanitizers that `specs/03-testing.md` §2 relies on.
   This is where most of the coupling lives, across every test file.
3. Capability boundary: the `--allow-*` grants in both `deno.json` files and the
   grants the launcher computes at start, which hold the loopback-only network
   posture, the pinned list of spawnable binaries and the environment allowlist.

On 2026-10-09 Deno's maintainers announced that the runtime will receive
maintenance releases for one more year and that its development ends after
that. A runtime that holds provider credentials and spawns tools cannot stay on
an end-of-life interpreter, and every new test written to the Deno dialect
raises the cost of leaving it. Separately, the restrictive-by-default execution
model has been a source of daily friction for a one-person project.

Layer 0 stance #3 keeps TypeScript as the prototyping tier while the Rust line
advances downward (D25). The runtime of that tier is therefore a near-term
choice, not a permanent one, and the choice must not make the Rust move harder.

## Decision

The TypeScript tier moves to Node.js on the active LTS line.

- Source and tests use `node:` builtins and the declared ports only. No
  runtime-specific global (`Deno.*`, `Bun.*`) remains once the move completes.
  The runtime is thereby a swappable component under stance #1: another
  Node-compatible runtime is a flag, not a port.
- Delivery is a strangler, never a cutover. Runtime source becomes
  runtime-neutral first, while still running on Deno, with the golden suite as
  the witness that behaviour did not change. Tests move by codemod to
  `node:test` and `node:assert/strict`, with a committed file list partitioning
  the unit lane between the two runtimes until the list covers every file. The
  gate, typecheck and import-graph tooling move next; the launcher last.
- The capability posture moves with the runtime. Filesystem and child-process
  restriction use Node's `--permission` flags. The network allowlist becomes an
  egress-grant value declared in `contract/`, computed where the serve-unix
  grants are computed today, and enforced at the three places the process opens
  a network connection: the provider HTTP transport, the MCP transport and the
  `DnsResolver` port. Process spawning is confined to the `ProcessSpawner` port
  by the architecture lane. Environment reads were already confined to
  `config/`.
- The compiled CLI (`deno compile`, `dist/dyfj-bin`) is removed. The
  interactive surface is the Rust REPL (D23); the TypeScript CLI runs from
  source.
- A `runtime.neutral` gate lane counts remaining runtime-specific references
  against a committed allow-list that may only shrink, on the pattern of
  `scripts/arch-size-exceptions.json`. It reports first, fails on growth, and
  fails on any entry once the count reaches zero.

## Alternatives considered

**Bun.** Fast startup, TypeScript without flags, a Jest-shaped test runner that
would take the bdd-style tests with little change, and a single-file compile.
Declined as the commitment because it has no permission model at all and is a
single-vendor runtime whose owner's stated interest is its own tooling, the
shape of risk that just materialised with Deno. Writing to the `node:` surface
keeps it available later at near-zero cost, so choosing Node forecloses
nothing.

**Move the engine server to Rust now.** Stance #3 says the code is going
there, the REPL is already Rust, and the process seam is defined (D15,
`01-architecture.md` §10). Declined as the response to this event: it rewrites
every runtime module and consumes the close-the-loop milestone. The runtime
swap is a dialect change; the Rust port is a redesign. The swap removes
Deno-specific host calls behind the ports the Rust port will need anyway.

**Stay on Deno for the maintenance year.** Twelve months of security releases,
open source, a green gate today. Declined because each month deepens the
dialect in the test suite, `@std` and Node-compatibility maintenance will thin
as the team moves on, and an end-of-life runtime holding secrets is a
threat-model liability rather than a dependency concern.

## Consequences

- The network allowlist is enforced in-process rather than by the runtime.
  That holds against a misbehaving model and a careless operator; it does not
  hold against a malicious dependency, which Deno's model did constrain. This
  is a named regression. An OS-level sandbox around the server process is the
  way to recover it and is tracked as follow-on work, not as a condition of the
  move.
- `node:test` has no op or resource sanitizers. A per-file check of active
  handles in the test-lane helper replaces them and is weaker.
  `specs/03-testing.md` §2 is amended to say so when the tests move.
- Node's `--permission` follows symbolic links outside granted paths. The file
  tools' lexical path checks and real-path resolution already address this and
  are verified again when the launcher moves.
- `deno check`, `deno info` and the `deno lint` plugin are replaced by
  `tsc --noEmit` and an import graph built with the TypeScript compiler API.
  The import map in `prototype/deno.json` becomes `package.json` and a
  lockfile; the dependency-policy lanes are reworked for it.
- D6 is superseded. D15, D23 and D25 stand. README run instructions,
  `prototype/README.md`, the `01-architecture.md` port table and
  `CHANGELOG.md` are brought current by the changes that make each statement
  true, in the same commit, per the documentation discipline in `AGENTS.md`.
