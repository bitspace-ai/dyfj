# PRD-15 — Log as ground truth (phase 1b)

**Phase:** 1b, after the phase-1 exit (WO-24) and before phase 2. **Work
orders:** WO-25 … WO-28. **Decision:** maintainer chose to make README Section
1's claim true rather than soften it.

## Problem

README Section 1 says "the immutable message log is ground truth; memory is a
derived view." The code does not do this (`00-baseline-findings.md` defect 10):

- **Sessions.** `sessions` rows are updated in place, and the updates carry no
  event.
- **Memories.** `memories` is written by a direct upsert with no event.
- **Ideas and packets.** They exist only in process memory and are lost on
  restart.
- **Receipts.** They are rendered at display time.

So the log cannot rebuild state, rewind and fork (README §6.2) have nothing to
stand on, and the audit trail has holes.

## Goals

1. **Every state change is an event.** The unjournaled-mutation list from
   `02-data-layer.md` §2 is empty.
2. **Projected tables are rebuildable** from `events` by deterministic
   projectors, proven by the `projections.replay` gate lane (`02-data-layer.md`
   §7).
3. **Ideas and packets become durable** as events plus a projection.
4. **The Section 1 status note comes out.** The "Runtime status" note on the
   ground-truth decision is removed because it is no longer needed.

## Non-goals

- Rewind and fork as user features. This PRD makes them possible; it doesn't
  ship them.
- Receipt records. Those are phase 2 (PRD-20), built on this.
- Backfilling events for historical session updates that were never evented.

## Allowed behavior change

Phase 1's freeze is lifted for exactly these changes:

- **New event types and their rows.** Snapshot diffs in the golden suite are
  expected here. Each new-event diff is reviewed and named in its PR.
- **Ideas and packets survive a server restart.** A new golden scenario pins
  this.

Everything else stays frozen: CLI, RPC methods and payloads, projected table
contents, and receipts.

## Requirements

- **R1. DDL first.** New `event_type` values and any payload columns are added
  through a forward migration plus the `current/` baseline, then
  `schema.codegen`. Candidate event types (final names are decided in WO-25):
  - `session_updated`
  - `memory_written`
  - `idea_marked`
  - `packet_drafted`
- **R2. Empty list, enforced.** `store/unjournaled.ts` is empty, and the
  conformance suite fails if anything is added to it.
- **R3. Replay equivalence.** `projections.replay` is green on every golden
  scenario.
- **R4. MCP writes go through the journal.** The MCP server's `write_memory`
  emits `memory_written` through the journal, like the runtime.
- **R5. Existing databases keep working.** Rows written before the migration
  stay valid. Projections treat pre-existing rows as their initial state, and
  replay equivalence is asserted only for data written after the migration.
- **R6. Docs.** CHANGELOG `Added` lists the new event types. README Section 1's
  status note is removed and a revision-history line is added.

## Success metrics

- Unjournaled mutation kinds: 0, down from 4.
- Tables rebuildable from the log: `sessions` and `memories`, plus the
  ideas/packets projection.
- Ideas and packets survive a restart: yes.

## Risks

- **Replay can't reproduce `updated_at`.** Mitigation: projectors take
  timestamps from the event. Where the DDL uses `ON UPDATE CURRENT_TIMESTAMP`,
  the migration drops that clause so the projector sets `updated_at` explicitly.
  This is a DDL change, reviewed in WO-25.
- **Memory upserts are last-writer-wins by slug.** As events, the semantics must
  match exactly. Mitigation: the `memory_written` projector reproduces the
  upsert, and conformance cases cover repeated slugs.
