# Issue tracker: Linear (private)

Issues and specs for this repo live in the maintainers' private **Linear**
tracker (issue IDs are `BIT-###`), not in public GitHub issues. This repo is
public; coordination, strategy, and unfixed security findings stay in the
tracker and never land in committed artifacts. See `AGENTS.md` →
**Public/Private Boundary** and **Issue Tracking**.

## Access route

Use the `linear` skill, which selects the right access route per harness (the
Linear MCP integration where available, otherwise the 1Password-brokered CLI
wrapper) and encodes the house conventions for what belongs in an issue.

- **Find ready work / what's assigned**: query Linear via the `linear` skill.
- **Create / claim an issue**: for non-trivial work, create or claim a `BIT-###`
  issue before editing. One claimed issue per session.
- **Record progress / comment**: post progress, blockers, and evidence to the
  issue, not to chat.
- **Close**: close the issue with a summary when the work is done.

## When a skill says "publish to the issue tracker"

Create (or update) a `BIT-###` Linear issue via the `linear` skill.

## When a skill says "fetch the relevant ticket"

Read the `BIT-###` issue via the `linear` skill.

## Boundary rules (from AGENTS.md)

- **Tracker IDs are workflow metadata only.** A `BIT-###` ID may appear in branch
  names, commit messages, and PR titles/descriptions, but never substitutes for
  the *why* in durable content (code, comments, `CHANGELOG.md`, `README.md`,
  `specs/`, docs). An ID may accompany an explanation, never replace it.
- **No unfollowable private links in committed prose.** Durable content refers to
  work by the `BIT-###` format only, never by a Linear URL or a specific private
  issue link that a public reader cannot open.
- **Anything reaching GitHub is public.** Issue titles that surface in branch
  names or integration comments must be public-safe; private coordination detail
  stays in the tracker.
- **Security findings stay private until fixed.** Track them in Linear only; the
  change that fixes it describes the fix, and public disclosure follows via a
  `CHANGELOG.md` `Security` entry after the fix ships.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` and describe the PR workflow
here if this repo ever treats external PRs as feature requests; `/triage` reads
this flag.)_ External PRs are not currently run through the triage labels and
states; `/triage` reads only the Linear tracker.
