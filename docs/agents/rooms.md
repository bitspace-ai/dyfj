# Rooms: how a change moves from issue to merge

One issue, one branch, one agent at a time. This file states the rules every
agent follows when it takes a seat on this repository, whatever harness it
runs in. `AGENTS.md`, README Section 1 and `specs/` win over anything here.

## Seats

- **Implementer:** claims one tracker issue, works in a fresh branch cut
  from `origin/main`, carries it to an open pull request, and stops.
- **Reviewer:** reads the branch's full range against `main` before merge
  is proposed. The reviewer is a different model family from the
  implementer, on every branch, without exception.
- **Coordinator:** sequences work, stages tasks, verifies claims against
  their sources, and adjudicates review findings. Never implements.
- **Maintainer:** performs the acts no agent performs: acceptance testing,
  accepting a review, merging to `main`, mutating schema, changing scope,
  and operational deletion (branches, worktrees, data, daemons, or files
  outside the change's scope). Deleting replaced code inside a change is the
  implementer's job and is required by the strangler rule (`specs/README.md`
  decision D8, `specs/work-orders.md`). An agent that believes one of these is needed prepares it
  and stops. Claiming one happened when it did not is the highest-severity
  process violation here.

## Rules

1. Claim the issue before editing. Progress, blockers and evidence go on the
   issue; chat is not the record.
2. A discovery made while working an issue becomes a new issue, never
   absorbed work. Say so on the original issue and link the ID.
3. Tests land with the code, not after it (README Section 4). When a change
   fixes a defect or adds behavior, the test that pins it is shown failing
   on the unchanged code before the fix, and that evidence is recorded on
   the issue. Changes with nothing to test, such as docs, have no such
   step.
4. Before a change is called done, the aggregate gate (`deno task test` from
   the repository root) is green in full, Dolt integration lane included.
   Report the gate's own status line, not a summary of it. A red lane is not
   "pre-existing" until that lane has been run on `main` and shown red there.
5. Stop at believed-final and wait. No self-review; no acting on a review
   finding until the coordinator or maintainer has adjudicated it against
   the code.
6. Verify before relaying: an identifier is copied from command output; a
   finding is the thread, not a paraphrase. Distinguish verified, inherited
   and assumed. Report the failing half of a partial result unprompted.
7. Commits state the why in public-safe prose. A tracker ID may appear; a
   tracker link may not. No AI-tool attribution trailers. The changelog and
   the docs that describe the changed surface land in the same change.
8. The interactive runtime under test is driven by the maintainer, not by
   an agent. An agent that needs a runtime step writes a labelled,
   self-contained prompt for the maintainer and records what comes back.
9. When blocked on a decision only the maintainer can make, post the
   options with consequences and one recommendation, then stop.

## Why

These rules exist because of incidents, not theory. An autonomous lane once
accepted its own review receipt; an implementer once reported a red gate as
green because a pipe masked the exit code and called the failing lanes
pre-existing without checking. Each rule above closes one of those holes.
