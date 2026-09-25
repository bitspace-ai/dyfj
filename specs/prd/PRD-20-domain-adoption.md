# PRD-20 — Domain adoption (phase 2, outline only)

**Status:** not started. This outline records intent so phase-1 seams are shaped
for it. It must be re-interviewed and expanded before any work order is written.

## Intent

Make the runtime implement the semantics frozen in
`contracts/workbench/first-product/v1`: Room, Participant, Thread, AgentSpec,
Task, Run, RouteSpec, ContextPacket, Grant, Lease, Projection, Receipt, and
claim-source separation.

Today the runtime has `sessions` plus a flat `events` log, and the contract
package has no runtime consumer.

## Order (per Layer 0 #4: DDL first)

1. **DDL.** Write it for the phase-2 entity subset, derived from the contract's
   JSON Schemas. `schema.codegen` then yields TypeScript row types.
2. **Contract consumption.** Contract validation moves from "documents only" to
   also validating runtime-emitted records in the golden and integration tiers.
3. **Landing spots.** Phase-1 seams take the new concepts:

   | Phase-2 concept        | Phase-1 seam               |
   | ---------------------- | -------------------------- |
   | RouteSpec              | `resolveRoute`             |
   | ContextPacket          | `buildContext`             |
   | Run                    | each `agentLoop` execution |
   | Receipt reconciliation | `finalize`                 |
   | Grants                 | the tool policy            |

4. **Receipts.** Receipt families move from render-time strings to durable,
   reconciled records.

## Open questions for the phase-2 interview

- **Room vs. session.** Does a Room subsume the current session, or wrap it?
- **Session migration.** What is the migration story for existing
  `sessions`/`events` data?
- **First invariants.** Which contract invariants gate the first phase-2 PR, and
  which remain document-only?
- **Contract types.** Should the contract package's hand-written TypeScript
  interfaces (`semantic-rules.ts`) be generated from its JSON Schemas at that
  point?
