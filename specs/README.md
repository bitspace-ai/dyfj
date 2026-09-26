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
| `prd/PRD-10…15`           | Phase-1 and phase-1b requirements: problem, goals, requirements, metrics, risks   |
| `prd/PRD-20`              | Phase-2 outline (domain adoption); not yet actionable                             |
| `work-orders.md`          | Sequenced, one-PR-each instructions for agents                                    |
| `bug-log.md`              | Bugs found during phase 1: logged, not fixed inline                               |
| `backlog/`                | Retired or deferred capabilities, with re-entry criteria                          |

The structure, terminology and precedence rules are in _Structure and
terminology_ below.

An agent executing work should read `AGENTS.md`, README Section 1, this file,
and then the single work order it was handed, plus the specs that work order
cites.

## Structure and terminology

### Authority and precedence

```
README Section 1 (Decisions)          what DYFJ is; Layer 0 stances; non-negotiables
  └─ AGENTS.md Engineering Doctrine    how code must be shaped (four rules)
      └─ Specs  specs/00–03            the target design: what "good" looks like
          └─ PRDs  specs/prd/          scoped workstreams: why, goals, requirements, metrics
              └─ Work orders           one-PR executable instructions (work-orders.md)
                  └─ PR                the change itself, gate-green
```

- **Higher wins.** Each layer narrows the one above it and never overrides it.
  When two layers conflict, the higher one wins.
- **A work order never resolves a conflict itself.** If executing it would
  contradict its PRD, a spec, the doctrine, or Section 1, the agent stops and
  asks (standing rule 7). The fix is to amend the higher document through a
  recorded decision, or to correct the work order. The agent does not quietly
  deviate.
- **Side logs** sit outside the chain of authority:
  - `bug-log.md`: problems found and deferred.
  - `backlog/`: capabilities retired with re-entry criteria.

### Artifact types

| Term                                                           | What it is                                                                                          | Where                   |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------- |
| **Decision** (`D1`…)                                           | A maintainer choice and its consequence                                                             | Decision log below      |
| **Spec** (`00`–`03`)                                           | Normative design for one concern. `00` is observed facts, not decisions                             | `0N-*.md`               |
| **PRD**                                                        | Requirements for one workstream: problem, goals, non-goals, requirements, success metrics, risks    | `prd/PRD-NN-*.md`       |
| **Requirement** (`R1`…)                                        | A checkable condition a PRD must meet; numbered within its PRD                                      | Inside each PRD         |
| **Work order** (`WO-NN`)                                       | One PR: scope, steps, acceptance, stop-and-ask triggers                                             | `work-orders.md`        |
| **Standing rules**                                             | Rules every work order inherits (behavior freeze, strangler discipline, tests move with code, etc.) | Top of `work-orders.md` |
| **Golden scenario** (`1`–`12`)                                 | A black-box behavior snapshot that restructuring must not change                                    | `03-testing.md` §4      |
| **Gate lane** (`arch.imports`, `test.unit`, `schema.codegen`…) | One named, machine-enforced check in the CI gate                                                    | `03-testing.md` §6      |
| **Bug-log entry**                                              | A defect found during the work: logged, not fixed inline                                            | `bug-log.md`            |
| **Backlog entry**                                              | A retired or deferred capability, with history and re-entry criteria                                | `backlog/*.md`          |

### Phases

| Phase  | PRDs                                                                                                              | Behavior                                                  | Theme                                |
| ------ | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------ |
| **1**  | PRD-10 guardrails, PRD-11 runtime decomposition, PRD-12 extensibility, PRD-13 typed data layer, PRD-14 test suite | Frozen                                                    | Restructure how it's built           |
| **1b** | PRD-15 log as ground truth                                                                                        | Relaxed only for new event rows and durable ideas/packets | Make the event log true ground truth |
| **2**  | PRD-20 domain adoption (outline)                                                                                  | Changes                                                   | Rooms, Tasks, Runs, Grants, Receipts |

### Numbering conventions

- **Specs:** `00`–`03`, in reading order.
- **PRDs:** numbered by phase band, with `1x` for phase 1 and `2x` for phase 2.
  PRD-15 sits in the `1x` band but belongs to phase 1b, because it finishes the
  phase-1 data work.
- **Work orders:** one global sequence (`WO-00`…) in execution order, not
  grouped by PRD. For example, WO-12 and WO-13 belong to PRD-13, while WO-14
  belongs to PRD-12. Each PRD header lists its work orders, and the dependency
  graph at the top of `work-orders.md` is the authority on order.
- **Withdrawn items keep their numbers** so references stay stable (WO-18 and
  golden scenario 8).
- **Decisions are append-only.** A revised decision is marked superseded in its
  row and replaced by a new decision; it is never edited or renumbered in place.

### How a change flows

```
Decision → spec amended → PRD scopes it → work order written → agent executes
  → PR (gate + golden suite) → merge → CHANGELOG and/or README revision history
  → anything out of scope → bug-log or backlog
```

- **`CHANGELOG.md`** records code and behavior changes.
- **The root README's revision history** records revisions to the operating
  context, including this directory.

## Decision log (maintainer interview, 2026-09-25)

| #   | Decision                                                                                                                    | Consequence                                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| D1  | **Seams now, domain later.** Phase 1 restructures current behavior; phase 2 adopts the first-product contract model.        | Seams are named for their phase-2 landing spots; no new entities in phase 1       |
| D2  | **Ports and fakes.** Fakes only at declared ports; module mocking banned; fakes proven by conformance suites                | Replaces README §4 testing bullets (`03-testing.md` §1)                           |
| D3  | **TypeScript only.** `core/` is unchanged.                                                                                  | Superseded in part by D15: the Rust boundary is the process seam                  |
| D4  | **Specs live in the public repo** under `specs/`.                                                                           | Everything here must be public-safe; private context stays in the private tracker |
| D5  | **Approved deletions:** standalone workbench CLI, schema-drift shims, dead exports, HTTP naming. `schema/history/` is kept. | `01-architecture.md` §8                                                           |
| D6  | **`Deno.test` + `@std`**; Vitest retired at phase-1 exit                                                                    | Supervisor kept or retired on evidence (WO-23)                                    |
| D7  | **Extension layer.** Ideas, packets, friction and Linear sit behind an Extension interface, enabled by default.             | `01-architecture.md` §6                                                           |
| D8  | **Strangler execution:** characterization first, one seam per PR, old path deleted in the same PR                           | `work-orders.md` standing rules                                                   |
| D9  | **Row types generated from the DDL**, with a gate freshness check                                                           | `02-data-layer.md` §3                                                             |
| D10 | **`contracts/…/v1` frozen in phase 1**, as the phase-2 target                                                               | Its lanes unchanged                                                               |
| D11 | **Priority:** agent editability, then provider/tool extensibility                                                           | Work-order ordering                                                               |
| D12 | **Behavior frozen in phase 1**; bugs logged, not fixed                                                                      | Golden suite is the enforcement                                                   |

### Doctrine review (maintainer decisions, 2026-09-25)

| #   | Decision                                                                                                                                                                                                                              | Consequence                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| D13 | **AGENTS.md doctrine replaced.** It now has four rules: module graph acyclic with named exceptions; runtime ownership a tree, with callbacks only through ports; a single writer per piece of state; the event log as the write path. | `01-architecture.md` §4 allow-list, §5.7 `SessionOwner`                                                                    |
| D14 | **Make "the log is ground truth" true.** The alternative, softening the Section 1 claim, was rejected.                                                                                                                                | Event-first store (`02-data-layer.md` §2); PRD-15 as phase 1b; Section 1 carries a runtime-status note until PRD-15 closes |
| D15 | **Rust boundary is the JSON-RPC process seam**, not an in-process TypeScript interface.                                                                                                                                               | `01-architecture.md` §10                                                                                                   |
| D16 | **Entry files (`mod.ts`) and the deep-import ban are advisory.** Layer direction and cycles stay enforced.                                                                                                                            | Keeps the prototype tier fast; promote the rule if deep imports cause breakage                                             |

### Backlog decisions (2026-09-25)

| #   | Decision                                                                                                         | Consequence                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| D17 | **ACP lane retired to the backlog.** It is removed from the runtime, not kept dormant, and git history keeps it. | WO-00 runs before the golden suite; WO-18 withdrawn; golden scenario 8 retired; `backlog/acp-lane.md` holds the re-entry criteria |

### Process decisions (2026-09-26)

| #   | Decision                                                                                                                                                                                                                                                               | Consequence                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| D18 | **Tracker IDs scoped, not banned.** They are allowed in branch names, commits and PRs, where the tracker's GitHub integration links work and advances status. They stay out of code, docs, `CHANGELOG.md` and `specs/`, and never replace the why.                     | AGENTS.md Documentation Discipline; standing rule 5                                                                     |
| D19 | **Safeguards for public work content.** Security-shaped findings stay in the private tracker until fixed; agents take instructions only from `AGENTS.md`, README Section 1 and `specs/` on the default branch; `CODEOWNERS` requires maintainer review of those files. | AGENTS.md "Security findings stay private until fixed" and "Instruction Sources"; standing rule 2; `.github/CODEOWNERS` |

## Phase-1 exit

Not reached. WO-24 fills this section with measured values against each PRD's
success metrics.
