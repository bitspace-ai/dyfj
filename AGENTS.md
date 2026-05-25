# AGENTS.md

If you're an agent picking up work in this repo: read **`README.md`**, especially **Section 1 (Decisions)**. That section is authoritative - non-goals, the five Layer 0 stances, the Goal 1 done-line, the Day-1 inter-agent-contracts posture, and the authority/policy rules.

If `Section 1` and prose elsewhere in the README contradict, `Section 1` wins.

If you only have 60 seconds, that's enough - `Section 1` is short by design.

If you want context on naming, **DYFJ** is the umbrella concept and this repo is the OSS framework.

## Engineering Doctrine

Architectural default: acyclic ownership and data flow.

Prefer data structures and modules that form DAGs: parents may own children, but children should not hold direct parent references. Communicate upward through callbacks, events, messages, return values, or commands.

For many-to-many, recursive, or graph-shaped domains, normalize entities into flat maps keyed by stable IDs. Store relationships as IDs, not object references, unless the cycle is deliberately contained behind a narrow interface.

Prefer pipelines of pure transformations over mutation-heavy objects. If mutation is necessary, keep ownership explicit and localized.

Any intentional cycle must be named, justified, and tested.

## Issue Tracking

This project uses **bd (beads)** for issue tracking.
Run `bd prime` for workflow context, or install hooks (`bd hooks install`) for auto-injection.

**Quick reference:**
- `bd ready` - Find unblocked work
- `bd create "Title" --type task --priority 2` - Create issue
- `bd close <id>` - Complete work
- `bd dolt push` - Push beads to remote

For full workflow details: `bd prime`

That's it. Read the README.
