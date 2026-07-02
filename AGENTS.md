# AGENTS.md

If you're an agent picking up work in this repo: read **`README.md`**, especially **Section 1 (Decisions)**. That section is authoritative - project boundaries, the five Layer 0 stances, the Goal 1 done-line, the Day-1 inter-agent-contracts posture, and the authority/policy rules.

If `Section 1` and prose elsewhere in the README contradict, `Section 1` wins.

If you only have 60 seconds, that's enough - `Section 1` is short by design.

If you want context on naming, **DYFJ** is the umbrella concept and this repo is the OSS framework.

## Public/Private Boundary

This repo is **public** — it is the OSS framework half of DYFJ. Private strategy, operator workflow, and cross-repo personal context live elsewhere and must never land in public artifacts: code, comments, notes, commit messages, or `CHANGELOG.md`. Design intent may be *sourced* from private material, but anything committed here must be public-safe on its own. When in doubt, leave it out — a public artifact built from a non-public-safe draft is a defect, not a shortcut.

## Engineering Doctrine

Architectural default: acyclic ownership and data flow.

Prefer data structures and modules that form DAGs: parents may own children, but children should not hold direct parent references. Communicate upward through callbacks, events, messages, return values, or commands.

For many-to-many, recursive, or graph-shaped domains, normalize entities into flat maps keyed by stable IDs. Store relationships as IDs, not object references, unless the cycle is deliberately contained behind a narrow interface.

Prefer pipelines of pure transformations over mutation-heavy objects. If mutation is necessary, keep ownership explicit and localized.

Any intentional cycle must be named, justified, and tested.

## Documentation Discipline

Documentation is part of the change, not a follow-up. A commit that changes behavior, surface, or architecture updates the docs in the same commit — never leaving them to drift.

- **CHANGELOG.** Every behavior- or surface-affecting change lands a `CHANGELOG.md` entry under `[Unreleased]`, following [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/): grouped under `Added` / `Changed` / `Deprecated` / `Removed` / `Fixed` / `Security`, newest at the top, written for a reader who wasn't here. DYFJ has no release tags yet, so dated sections are cut from `[Unreleased]` rather than versioned. A pure-internal refactor with no observable change doesn't need an entry; anything that changes what the system does or exposes does.
- **Docs must not lie — directly or by omission.** `README.md`, `prototype/README.md`, `mcp/README.md`, and the README's Section 1 (Decisions) are operating context: they must match the ground truth of the code. A new transport, endpoint, task, flag, env var, or architectural seam that the docs don't mention is a lie by omission. When you add or change a surface, find where the docs describe that area and bring it current in the same change; if a doc claim is now false, fix it — don't leave it.
- **Scope honestly.** Document what is true *now*. Mark in-progress or deferred work as such rather than describing the intended end-state as if it shipped.
- **Two trails, kept distinct.** `CHANGELOG.md` records code/behavior changes; the root README's Revision history records document-level revisions of the operating context. Update whichever the change touches; keep both current.
- **Keep private tracker IDs out of public artifacts.** Private tracker IDs belong in the tracker and private coordination notes, not commit messages, PR descriptions, code comments, `CHANGELOG.md`, docs, or other public repo artifacts. Explain the *why* in public-safe prose so a reader who cannot access the private tracker loses nothing.
- **No AI-tool attribution in git history.** Never add `Co-authored-by` (or similar) trailers crediting a harness or model (Cursor, Composer, Claude, etc.) — a tool is not a person or a git contributor. Disable commit attribution at the harness source when the setting exists.

## Issue Tracking

Maintainers coordinate work in a private tracker. Use the available tracker integration to find ready work, claim, record progress, and close issues; for non-trivial work, create or claim an issue before editing. Keep tracker-specific identifiers and private coordination details out of public artifacts.

That's it. Read the README.
