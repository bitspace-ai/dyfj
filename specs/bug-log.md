# Phase-1 bug log

Phase 1 freezes behavior, so bugs found during restructuring are recorded here
and not fixed inline. Each entry must be public-safe prose.

Entry format: date, symptom, location (`file:line` at the time found), suspected
cause, and the work order that found it. Fixes land as separate, dedicated
changes with a CHANGELOG `Fixed` entry.

## Open

- 2026-09-25 — **Model-registry load errors are silently dropped on the ACP
  dispatch path.**
  - **Location:** `prototype/src/workbench.ts:1535-1543`.
  - **Symptom:** a catalog failure is swallowed rather than surfaced.
  - **Found during:** baseline analysis. WO-16 must preserve the current
    behavior.
- 2026-09-25 — **Native tool results do not get the secret-shape scrub** that is
  applied to reconstructed ACP history
  (`prototype/src/external-agent-runtime.ts:530-553`).
  - **Status:** decision needed; this may be intended.
  - **Found during:** baseline analysis.
- 2026-09-25 — **Ideas and packets are lost on server restart.**
  - **Location:** `prototype/src/idea-packet.ts:809`
    (`defaultIdeaPacketRegistry`, a module-level in-memory singleton).
  - **Symptom:** marked ideas and drafted packets disappear when the engine
    server restarts. They never reach the event log.
  - **Status:** scheduled. PRD-15 WO-27 makes them durable. Phase 1 only moves
    ownership (WO-20).
  - **Found during:** doctrine review.
