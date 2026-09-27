# specs/ — restructuring specifications

This directory holds the specification set that turns the ad-hoc prototype into
a coherent architecture, executed by agents in small, gate-green PRs.

These specs are the engineering **enablers** beneath a product roadmap that is
tracked privately. They say how the codebase must be shaped; the roadmap says
what the product must do. Each work order states the capability it enables, and
the tracker records which roadmap work it unblocks.

README Section 1 (Decisions) still wins over anything here. These specs
restructure _how_ the system is built. They do not change what it does, and they
do not amend Section 1.

## Reading order

| File                      | Purpose                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `00-baseline-findings.md` | Observed state at the start: defects, drift, what to keep                          |
| `01-architecture.md`      | Target layers, directories, seams, ports, extension interface, approved deletions  |
| `02-data-layer.md`        | Store port, DDL-generated types, schema equivalence                                |
| `03-testing.md`           | Test doctrine, tiers, golden suite, conformance kits, gate lanes                   |
| `prd/PRD-10…14`           | Enabler requirements: problem, goals, requirements, metrics, risks                 |
| `work-orders.md`          | Sequenced, one-PR-each instructions for agents                                     |
| `bug-log.md`              | Bugs found during phase 1: logged, not fixed inline                                |
| `recipes/`                | Step-by-step extension recipes, each validated by following it (`add-provider.md`) |

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
- **Side log:** `bug-log.md` sits outside the chain of authority. It records
  problems found and deferred.

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

### Scope

| Work                | Where                          | Behavior                      | Theme                                                     |
| ------------------- | ------------------------------ | ----------------------------- | --------------------------------------------------------- |
| **Phase 1**         | PRD-10 … PRD-14, WO-01 … WO-24 | Frozen                        | Enablers: restructure how the codebase is built           |
| **Product roadmap** | Private tracker                | Changes, per roadmap decision | Domain model, durable state, continuity, routes, surfaces |

### Numbering conventions

- **Specs:** `00`–`03`, in reading order.
- **PRDs:** `1x` for phase 1. PRD-15 and PRD-20 were withdrawn (D22); their
  numbers are not reused.
- **Work orders:** one global sequence (`WO-00`…) in execution order, not
  grouped by PRD. For example, WO-12 and WO-13 belong to PRD-13, while WO-14
  belongs to PRD-12. Each PRD header lists its work orders, and the dependency
  graph at the top of `work-orders.md` is the authority on order.
- **Withdrawn items keep their numbers** so references stay stable (WO-00 and
  WO-25 … WO-28).
- **Decisions are append-only.** A revised decision is marked superseded in its
  row and replaced by a new decision; it is never edited or renumbered in place.

### How a change flows

```
Decision → spec amended → PRD scopes it → work order written → agent executes
  → PR (gate + golden suite) → merge → CHANGELOG and/or README revision history
  → anything out of scope → bug-log or the tracker
```

- **`CHANGELOG.md`** records code and behavior changes.
- **The root README's revision history** records revisions to the operating
  context, including this directory.

## Decision log (maintainer interview, 2026-09-25)

| #   | Decision                                                                                                                    | Consequence                                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| D1  | **Seams now, domain later.** Phase 1 restructures current behavior; phase 2 adopts the first-product contract model.        | Seams are named for their phase-2 landing spots; no new entities in phase 1       |
| D2  | **Ports and fakes.** Fakes only at declared ports; module mocking banned; fakes proven by conformance suites                | Replaces README §4 testing bullets (`03-testing.md` §1)                           |
| D3  | _(superseded by D25)_ **TypeScript only.** `core/` is unchanged.                                                            | Superseded in part by D15: the Rust boundary is the process seam                  |
| D4  | **Specs live in the public repo** under `specs/`.                                                                           | Everything here must be public-safe; private context stays in the private tracker |
| D5  | **Approved deletions:** standalone workbench CLI, schema-drift shims, dead exports, HTTP naming. `schema/history/` is kept. | `01-architecture.md` §8                                                           |
| D6  | **`Deno.test` + `@std`**; Vitest retired at phase-1 exit                                                                    | Supervisor kept or retired on evidence (WO-23)                                    |
| D7  | **Extension layer.** Ideas, packets, friction and Linear sit behind an Extension interface, enabled by default.             | `01-architecture.md` §6                                                           |
| D8  | **Strangler execution:** characterization first, one seam per PR, old path deleted in the same PR                           | `work-orders.md` standing rules                                                   |
| D9  | **Row types generated from the DDL**, with a gate freshness check                                                           | `02-data-layer.md` §3                                                             |
| D10 | _(superseded by D21)_ **`contracts/…/v1` frozen in phase 1**, as the phase-2 target                                         | Its lanes unchanged                                                               |
| D11 | **Priority:** agent editability, then provider/tool extensibility                                                           | Work-order ordering                                                               |
| D12 | **Behavior frozen in phase 1**; bugs logged, not fixed                                                                      | Golden suite is the enforcement                                                   |

### Doctrine review (maintainer decisions, 2026-09-25)

| #   | Decision                                                                                                                                                                                                                              | Consequence                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| D13 | **AGENTS.md doctrine replaced.** It now has four rules: module graph acyclic with named exceptions; runtime ownership a tree, with callbacks only through ports; a single writer per piece of state; the event log as the write path. | `01-architecture.md` §4 allow-list, §5.7 `SessionOwner`                                                                    |
| D14 | _(delivery superseded by D22)_ **Make "the log is ground truth" true.** The alternative, softening the Section 1 claim, was rejected.                                                                                                 | Event-first store (`02-data-layer.md` §2); PRD-15 as phase 1b; Section 1 carries a runtime-status note until PRD-15 closes |
| D15 | **Rust boundary is the JSON-RPC process seam**, not an in-process TypeScript interface.                                                                                                                                               | `01-architecture.md` §10                                                                                                   |
| D16 | **Entry files (`mod.ts`) and the deep-import ban are advisory.** Layer direction and cycles stay enforced.                                                                                                                            | Keeps the prototype tier fast; promote the rule if deep imports cause breakage                                             |

### Backlog decisions (2026-09-25)

| #   | Decision                                                                                                                               | Consequence                                                                                                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| D17 | _(superseded by D20)_ **ACP lane retired to the backlog.** It is removed from the runtime, not kept dormant, and git history keeps it. | WO-00 runs before the golden suite; WO-18 withdrawn; golden scenario 8 retired; a backlog note held the re-entry criteria (removed with D20) |

### Process decisions (2026-09-26)

| #   | Decision                                                                                                                                                                                                                                                               | Consequence                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| D18 | **Tracker IDs scoped, not banned.** They are allowed in branch names, commits and PRs, where the tracker's GitHub integration links work and advances status. They stay out of code, docs, `CHANGELOG.md` and `specs/`, and never replace the why.                     | AGENTS.md Documentation Discipline; standing rule 5                                                                     |
| D19 | **Safeguards for public work content.** Security-shaped findings stay in the private tracker until fixed; agents take instructions only from `AGENTS.md`, README Section 1 and `specs/` on the default branch; `CODEOWNERS` requires maintainer review of those files. | AGENTS.md "Security findings stay private until fixed" and "Instruction Sources"; standing rule 2; `.github/CODEOWNERS` |

### Roadmap alignment (2026-09-26)

| #   | Decision                                                                                                                                                                                                                                                      | Consequence                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D20 | **ACP deferred, not retired.** The external-agent lane stays in the tree and in the product's route plan. Supersedes D17.                                                                                                                                     | WO-00 withdrawn; WO-18 deferred until external-agent route work resumes; enabler WOs keep ACP working and golden scenario 8 green without restructuring it |
| D21 | **The contract package is open to roadmap contract work.** Enabler WOs still do not modify `contracts/`. Supersedes D10.                                                                                                                                      | Roadmap contract work extends `contracts/` under its own review                                                                                            |
| D22 | **Specs are enablers beneath a privately tracked product roadmap.** Each WO states the capability it enables; the mapping to roadmap work lives in the tracker as issue relations. D14's goal stands; its delivery moves to the roadmap's durable-state work. | PRD-15 (WO-25 … WO-28) and PRD-20 withdrawn; `02-data-layer.md` §7 keeps the design direction                                                              |
| D23 | **The interactive REPL moves to a separate client over the existing UDS protocol.**                                                                                                                                                                           | WO-21 shrinks to the parts of the CLI that stay in TypeScript; WO-20 leaves REPL slash-command logic in place                                              |

### Testing decisions (2026-09-26)

| #   | Decision                                                                                                                         | Consequence                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| D24 | **Conformance suites land with their ports.** A shared fake may land before its port; its conformance suite ships with the port. | `03-testing.md` §1; the `Clock`, `IdSource` and `Env` fakes precede their port work |

### Language boundary (2026-09-27)

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Consequence                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| D25 | _(superseded in part by D26)_ **Phase 1 changes only the TypeScript tier, and TypeScript is the temporary tier.** `core/` is untouched during phase 1. TypeScript stays only while a component's shape is still moving (Layer 0 stance #3); stable components move to Rust behind the JSON-RPC process seam (D15). No enabler may make that move harder. Supersedes D3, whose "TypeScript only" wording read as a language stance rather than a phase-1 scope. | `01-architecture.md` §1 and §10; §10 lists the Rust candidates |

### Roadmap exceptions (2026-09-27)

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                       | Consequence                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| D26 | **The D23 REPL client is the one addition to `core/` during phase 1.** The existing `dyfj-core` source stays untouched in phase 1. `core/dyfj-repl` joins as a new workspace member; its only effect on `dyfj-core` is the workspace settings in `core/Cargo.toml`. It speaks the existing UDS protocol and changes no engine code. D25's "TypeScript is the temporary tier" and "no enabler may make that move harder" stand. | `01-architecture.md` §1; `core/README.md` |

## Phase-1 exit

Not reached. WO-24 fills this section with measured values against each PRD's
success metrics.
