# Rooms: how a change moves from issue to merge

One issue, one branch, one agent at a time. This file states the rules every
agent follows when it takes a seat on this repository, whatever harness it
runs in. `AGENTS.md`, README Section 1 and `specs/` win over anything here.

## Seats

- **Implementer:** claims one tracker issue, works in a fresh branch cut
  from `origin/main`, carries it to an open pull request, and stops.
- **Reviewer:** reads the branch's full range against `main` before merge
  is proposed, in a session that shares no context with the implementer.
  On the standard lane the reviewer is a different model family from the
  implementer, without exception. On the fast lane any family may review.
- **Coordinator:** sequences work, stages tasks, verifies claims against
  their sources, and adjudicates review findings. Implements only a small
  fix, and only when staging an implementer for it would cost more than
  making the fix. That fix follows the implementer's rules, and the
  maintainer adjudicates its review findings.
- **Maintainer:** performs the acts no agent performs: acceptance testing,
  accepting a review, merging to `main`, changing scope, operational
  deletion (branches, worktrees, data, daemons, or files outside the
  change's scope), and operational mutation of a live operator database
  (applying DDL or correcting data on a running instance). Deleting
  replaced code inside a change is the implementer's job under the
  strangler rule (`specs/README.md` decision D8, `specs/work-orders.md`).
  Writing an approved schema change as a forward migration, folded into the
  current schema per `schema/migrations/README.md`, is implementer work; an
  unapproved DDL change is a stop-and-ask, per the work orders' standing
  rules. An agent that believes one of these is needed prepares it
  and stops. Claiming one happened when it did not is the highest-severity
  process violation here.

## Lanes

Every change runs on one of two lanes. The lane decides how much review and
maintainer attention the change costs, and it is set by blast radius.

- **Standard lane:** every rule below applies as written. A change is on
  the standard lane when it touches any protected surface:
  - `schema/`, migrations, or the event-log write and replay path;
  - permissions, the sandbox, egress, or spawn and environment limits;
  - spend limits, budget checks, pricing, or the model catalog;
  - redaction, secrets, or credential handling;
  - the publish tools or the gate (`scripts/aggregate-test-gate.ts` and
    its lanes);
  - `AGENTS.md`, README Section 1, `specs/`, this file, `.github/`, or
    dependency versions;
  - anything security-shaped (AGENTS.md, Public/Private Boundary).
- **Fast lane:** a change that touches no protected surface, such as REPL
  and shell UX, messages and help text, docs outside the protected files,
  and fixes confined to unprotected modules. The Reviewer seat and rules 8
  and 10 have fast-lane forms; everything else applies as written.

The coordinator or maintainer sets the lane when the issue is staged, and
records it on the issue. When the lane is unrecorded or in doubt, the change
is on the standard lane. A lane can be raised during the work and never
lowered: an implementer whose change comes to touch a protected surface
records that on the issue and continues on the standard lane.

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
4. Before a change is called done, the aggregate gate (`npm test` from the
   repository root) is green in full, Dolt integration lane included.
   Report the gate's own status line, not a summary of it. A red lane is not
   "pre-existing" until that lane has been run on `main` and shown red there.
5. Stop at believed-final and wait. No self-review; no acting on a review
   finding until the coordinator or maintainer has adjudicated it against
   the code.
6. Verify before relaying: an identifier is copied from command output; a
   finding is the thread, not a paraphrase. Distinguish verified, inherited
   and assumed. Report the failing half of a partial result unprompted.
7. Commits state the why in public-safe prose. A tracker ID may appear; a
   tracker link may not. A pull request's branch name, title and description
   name only the ID of the issue it delivers (`docs/agents/issue-tracker.md`,
   Boundary rules). No AI-tool attribution trailers. The changelog and
   the docs that describe the changed surface land in the same change.
8. The interactive runtime under test is driven by the maintainer, not by
   an agent. An agent that needs a runtime step writes a labelled,
   self-contained prompt for the maintainer and records what comes back.
   _Fast lane:_ the implementer may drive the disposable runtime with
   `node scripts/scratch-runtime.ts` from `prototype/` (`up`, `env`, `exec`,
   `down`; see `prototype/README.md`, Disposable runtime). It uses a scratch
   Dolt fixture, scratch configuration and a scripted loopback model. The
   implementer records the commands, reply, receipt and commit as evidence
   on the issue; `exec` captures them and `down` prints the evidence block.
   For changes the loopback model cannot exercise, including real-model
   behavior and paid routes, rule 8 applies as written.
9. When blocked on a decision only the maintainer can make, post the
   options with consequences and one recommendation, then stop.
10. _Fast lane:_ the maintainer may accept and merge fast-lane pull
    requests in batches, on each change's aggregate gate status line
    (rule 4), its adjudicated review and its recorded runtime evidence, and
    acceptance-test the batch rather than each change.
    Merging stays the maintainer's act.

## Why

These rules exist because of incidents, not theory. An autonomous lane once
accepted its own review receipt; an implementer once reported a red gate as
green because a pipe masked the exit code and called the failing lanes
pre-existing without checking. Each rule above closes one of those holes.

The lanes exist because each rule costs maintainer attention on every
change, whatever its size, and that attention is the scarcest resource in
this repository. The standard lane spends it where a wrong change is
expensive. The fast lane keeps the invariants those incidents taught: no
agent accepts its own review, the gate's own status line is reported, and
only the maintainer merges.
