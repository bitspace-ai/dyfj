# specs/ — restructuring specifications

This directory holds the specification set that turns the ad-hoc prototype into
a coherent architecture, executed by agents in small, gate-green PRs.

README Section 1 (Decisions) still wins over anything here. These specs
restructure _how_ the system is built. They do not change what it does, and they
do not amend Section 1.

## Reading order

| File                      | Purpose                                                                           |
| ------------------------- | --------------------------------------------------------------------------------- |
| `00-baseline-findings.md` | Observed state at the start: defects, drift, what to keep                         |
| `01-architecture.md`      | Target layers, directories, seams, ports, extension interface, approved deletions |
| `02-data-layer.md`        | Store port, DDL-generated types, schema equivalence                               |
| `03-testing.md`           | Test doctrine, tiers, golden suite, conformance kits, gate lanes                  |
| `prd/PRD-10…14`           | Phase-1 product requirements: problem, goals, requirements, metrics, risks        |
| `prd/PRD-20`              | Phase-2 outline (domain adoption); not yet actionable                             |
| `work-orders.md`          | Sequenced, one-PR-each instructions for agents                                    |
| `bug-log.md`              | Bugs found during phase 1: logged, not fixed inline                               |

An agent executing work should read `AGENTS.md`, README Section 1, this file,
and then the single work order it was handed, plus the specs that work order
cites.

## Decision log (maintainer interview, 2026-09-25)

| #   | Decision                                                                                                                    | Consequence                                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| D1  | **Seams now, domain later.** Phase 1 restructures current behavior; phase 2 adopts the first-product contract model.        | Seams are named for their phase-2 landing spots; no new entities in phase 1       |
| D2  | **Ports and fakes.** Fakes only at declared ports; module mocking banned; fakes proven by conformance suites                | Replaces README §4 testing bullets (`03-testing.md` §1)                           |
| D3  | **TypeScript only.** `core/` is unchanged.                                                                                  | Store port shaped for a later Rust adapter                                        |
| D4  | **Specs live in the public repo** under `specs/`.                                                                           | Everything here must be public-safe; private context stays in the private tracker |
| D5  | **Approved deletions:** standalone workbench CLI, schema-drift shims, dead exports, HTTP naming. `schema/history/` is kept. | `01-architecture.md` §8                                                           |
| D6  | **`Deno.test` + `@std`**; Vitest retired at phase-1 exit                                                                    | Supervisor kept or retired on evidence (WO-23)                                    |
| D7  | **Extension layer.** Ideas, packets, friction and Linear sit behind an Extension interface, enabled by default.             | `01-architecture.md` §6                                                           |
| D8  | **Strangler execution:** characterization first, one seam per PR, old path deleted in the same PR                           | `work-orders.md` standing rules                                                   |
| D9  | **Row types generated from the DDL**, with a gate freshness check                                                           | `02-data-layer.md` §3                                                             |
| D10 | **`contracts/…/v1` frozen in phase 1**, as the phase-2 target                                                               | Its lanes unchanged                                                               |
| D11 | **Priority:** agent editability, then provider/tool extensibility                                                           | Work-order ordering                                                               |
| D12 | **Behavior frozen in phase 1**; bugs logged, not fixed                                                                      | Golden suite is the enforcement                                                   |

## Phase-1 exit

Not reached. WO-24 fills this section with measured values against each PRD's
success metrics.
