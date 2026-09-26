# AGENTS.md

If you're an agent picking up work in this repo: read **`README.md`**, especially **Section 1 (Decisions)**. That section is authoritative - project boundaries, the five Layer 0 stances, the Goal 1 done-line, the Day-1 inter-agent-contracts posture, and the authority/policy rules.

If `Section 1` and prose elsewhere in the README contradict, `Section 1` wins.

If you only have 60 seconds, that's enough - `Section 1` is short by design.

If you want context on naming, **DYFJ** is the umbrella concept and this repo is the OSS framework.

## Public/Private Boundary

This repo is **public** — it is the OSS framework half of DYFJ. Private strategy, operator workflow, and cross-repo personal context live elsewhere and must never land in public artifacts: code, comments, notes, commit messages, or `CHANGELOG.md`. Design intent may be *sourced* from private material, but anything committed here must be public-safe on its own. When in doubt, leave it out — a public artifact built from a non-public-safe draft is a defect, not a shortcut.

## Engineering Doctrine

Architectural default: acyclic ownership, single writers, and one ground-truth log. Four graphs, four rules:

1. **Module graph: acyclic.** Imports form a DAG, enforced by the gate. An intentional cycle is allowed only by name, from a committed allow-list entry that states its justification and cites the test that exercises it.
2. **Runtime ownership: a tree.** Parents may own children; children hold no parent references. Communicate upward through return values and emitted events first. Callbacks are allowed only through declared ports (for example an approver or a frame sink), and a callback must never re-enter the code that called it. Protocol round trips that are inherently bidirectional (server-to-client approval requests, ACP permission requests, MCP callbacks) are named cycles under rule 1's allow-list.
3. **State: single writer.** Every piece of mutable state has exactly one owner, and everyone else changes it by sending that owner a message. Long-lived per-session state (turn lock, external-agent handle, budget scope) belongs to one session owner. No module-level mutable singletons.
4. **Data: identity by stable ID, and the log is the write path.** Entities reference each other by stable ID, never by object reference. Every state change is recorded as an immutable event; tables are projections of the event log, rebuildable by replay. Reference data (model catalog, prompts) is the declared exception, versioned through `schema/`. Any other exception must be declared and justified where it is implemented.

Prefer pipelines of pure transformations over mutation-heavy objects. When mutation is necessary, rule 3 decides who may perform it.

**Why these rules:** acyclic, tree-owned code ports to Rust without ownership contortions (Layer 0 stance #3); an acyclic module graph lets an agent understand a module from its dependencies alone; single writers and a replayable log are what make audit, cost accounting, rewind, and fork trustworthy (README Section 1: the immutable log is ground truth).

## Documentation Discipline

Documentation is part of the change, not a follow-up. A commit that changes behavior, surface, or architecture updates the docs in the same commit — never leaving them to drift.

- **CHANGELOG.** Every behavior- or surface-affecting change lands a `CHANGELOG.md` entry under `[Unreleased]`, following [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/): grouped under `Added` / `Changed` / `Deprecated` / `Removed` / `Fixed` / `Security`, newest at the top, written for a reader who wasn't here. DYFJ has no release tags yet, so dated sections are cut from `[Unreleased]` rather than versioned. A pure-internal refactor with no observable change doesn't need an entry; anything that changes what the system does or exposes does.
- **Docs must not lie — directly or by omission.** `README.md`, `prototype/README.md`, `mcp/README.md`, and the README's Section 1 (Decisions) are operating context: they must match the ground truth of the code. A new transport, endpoint, task, flag, env var, or architectural seam that the docs don't mention is a lie by omission. When you add or change a surface, find where the docs describe that area and bring it current in the same change; if a doc claim is now false, fix it — don't leave it.
- **Scope honestly.** Document what is true *now*. Mark in-progress or deferred work as such rather than describing the intended end-state as if it shipped.
- **Two trails, kept distinct.** `CHANGELOG.md` records code/behavior changes; the root README's Revision history records document-level revisions of the operating context. Update whichever the change touches; keep both current.
- **Tracker IDs: workflow metadata only, never a substitute for the why.** Tracker IDs may appear in branch names, commit messages, and PR titles and descriptions, where the tracker's GitHub integration uses them to link work and advance status. They stay out of durable content (code, code comments, `CHANGELOG.md`, `README.md`, `specs/`, and other docs), which outlives the tracker and is read by people who cannot open it. An ID may accompany an explanation but never replace it: every commit and PR still states the *why* in public-safe prose. Anything that reaches GitHub is public, so issue titles that surface in branch names or integration comments must be public-safe, and private coordination details stay in the tracker.
- **No AI-tool attribution in git history.** Never add `Co-authored-by` (or similar) trailers crediting a harness or model (Cursor, Composer, Claude, etc.) — a tool is not a person or a git contributor. Disable commit attribution at the harness source when the setting exists.

## Issue Tracking

Maintainers coordinate work in a private tracker. Use the available tracker integration to find ready work, claim, record progress, and close issues; for non-trivial work, create or claim an issue before editing. Tracker IDs follow the scoping rule under Documentation Discipline; private coordination details stay in the tracker.

## Restructuring in progress

Phase-1 restructuring is specified in **`specs/`**. If you were handed a work order, read `specs/README.md` and that work order in `specs/work-orders.md`; its standing rules (behavior freeze, strangler discipline, tests move with code) apply on top of this file.

That's it. Read the README.
