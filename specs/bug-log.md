# Phase-1 bug log

Phase 1 freezes behavior, so bugs found during restructuring are recorded here
and not fixed inline. Each entry must be public-safe prose. Security-shaped
findings are never recorded here; they go to the private tracker (AGENTS.md).

Entry format: date, symptom, location (`file:line` at the time found), suspected
cause, and the work order that found it. Fixes land as separate, dedicated
changes with a CHANGELOG `Fixed` entry.

## Open

- 2026-09-25 — **Ideas and packets are lost on server restart.**
  - **Location:** `prototype/src/idea-packet.ts:809`
    (`defaultIdeaPacketRegistry`, a module-level in-memory singleton).
  - **Symptom:** marked ideas and drafted packets disappear when the engine
    server restarts. They never reach the event log.
  - **Status:** scheduled. PRD-15 WO-27 makes them durable. Phase 1 only moves
    ownership (WO-20).
  - **Found during:** doctrine review.

## Closed

- 2026-09-25 — **Model-registry load errors silently dropped on the ACP dispatch
  path** (`prototype/src/workbench.ts:1535-1543`). Moot: the path is deleted
  when the ACP lane is retired (WO-00).
