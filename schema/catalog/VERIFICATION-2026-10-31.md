# Catalog verification — 2026-10-31

Sources and figures behind the four GPT-6 rows in `001_models.sql` that route
`codex-chatgpt/*`: `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6.1-terra` and
`gpt-6-luna`. All four route through the Codex ACP adapter on a ChatGPT
sign-in (`provider = 'codex-chatgpt'`, `api = 'acp'`, `base_url = 'acp'`), so
there is no reseller price to reconcile: the route is billed by subscription,
and every cost column is 0 because the route reports no USD cost at all.

The sources were read on 2026-10-30, in the research that drafted these rows.
This note records them, labelled, on 2026-10-31, when the rows landed.

## Sources

- Codex models: `https://learn.chatgpt.com/docs/models.md`, which redirects
  from `https://developers.openai.com/codex/models.md`. No page date.
- Codex pricing: `https://learn.chatgpt.com/docs/pricing.md`, which redirects
  from `https://developers.openai.com/codex/pricing.md`. No page date.
- Bundled model catalog: `https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json`
  at commit f2ac998 (2026-10-30), and the same file at tag `rust-v0.153.4`.
- Releases: `https://github.com/openai/codex/releases/tag/rust-v0.165.0`
  (2026-10-27, adds GPT-6.1 Terra) and the releases index for 0.161.0
  (2026-10-07, GPT-6.1 Sol becomes the bundled default).
- API model cards: `https://developers.openai.com/api/docs/models/gpt-6.1-sol`,
  `https://developers.openai.com/api/docs/models/gpt-6.1-terra`,
  `https://developers.openai.com/api/docs/models/compare`.
- Adapter versions: `https://registry.npmjs.org/@agentclientprotocol%2Fcodex-acp`.

## Observed — the model set

OpenAI's words, paraphrased: `gpt-6-astra` is the most capable, frontier
model; `gpt-6.1-sol` is near-Astra at lower cost and OpenAI's named
replacement for GPT-5.5 on Plus, Pro and Business; `gpt-6.1-terra` is fast and
efficient, aimed at writing, vision and computer use; `gpt-6-luna` is the most
efficient, for high-volume, focused coding.

The slug suffix must equal the Codex model ID exactly. The runner strips the
`codex-chatgpt/` prefix and passes the remainder as the Codex `model` value.

## Observed — context windows and output limits

| Codex model | Codex context (bundled catalog) | Docs figure | API card context / max out | row `context_window` |
| --- | --- | --- | --- | --- |
| `gpt-6-astra` | 272,000 (max 872,000) | not stated separately | 1,050,000 / 128,000 | 272,000 |
| `gpt-6.1-sol` | 272,000 (max 872,000) in the repo catalog | **500,000** | 1,050,000 / 128,000 | 500,000 |
| `gpt-6.1-terra` | 500,000 (max 872,000) | 500,000 | 1,050,000 / 128,000 | 500,000 |
| `gpt-6-luna` | 272,000 (max 872,000) | not stated separately | 1,050,000 / 128,000 | 272,000 |

The rows store the context window that applies on this route, which is the
Codex figure, not the API model card's 1,050,000. Where the docs and the
bundled catalog disagree — GPT-6.1 Sol, 500,000 against 272,000 — the row
follows the docs.

`max_output_tokens` 128,000 is the API card's figure on all four rows. Codex
does not publish a per-route output limit, so this is the only sourced number
and it is **inferred** as route-effective.

The 2026-10-31 canaries reported usable context windows of **475,000** for
`gpt-6.1-sol` and `gpt-6.1-terra`, and **258,400** for `gpt-6-astra` and
`gpt-6-luna`. Each is exactly 95% of its row's 500,000 or 272,000 tokens.
That 95% usable-window fraction is **inferred from the receipts**, not a
provider statement. The canaries support Sol's documented 500,000-token
window; the bundled catalog's 272,000 value was stale. No row values change.

## Observed — the adapter no longer blocks the generation

The draft that preceded this change found a blocker: `prototype/package.json`
pinned `@agentclientprotocol/codex-acp` 1.11.0 (published 2026-09-09), whose
lockfile resolved `@openai/codex` 0.153.4 (tagged 2026-09-04). At that version
the bundled `models.json` carried `gpt-6-astra` but not `gpt-6.1-sol`,
`gpt-6.1-terra` or `gpt-6-luna`.

That blocker is resolved. The tree pins `@agentclientprotocol/codex-acp`
**2.5.0** (published 2026-10-29), which depends on `@openai/codex` `^0.165.0`,
and 0.165.0 is the release that added GPT-6.1 Terra to the catalogs. The
version ladder in between, observed from the npm registry: 2.0.0 required
`^0.158.0`, 2.1.0 required `^0.159.1`.

Two minimum-client disagreements remain unresolved here, both observed and
both probably moot at the pinned version: the docs say GPT-6.1 Terra needs
Codex CLI 0.159.0 while the repo catalog at f2ac998 says 0.153.0, and
`gpt-6-luna` declares `minimal_client_version` 0.155.0.

The minimum-client figures above are published requirements and a version
constraint read from the registry. The 2026-10-31 context canaries exercised
all four models through the signed-in runner.

## Observed — plans

Every one of the four rows lists `plus`, `pro`, `prolite`, `business`, `team` and the
`self_serve_business_*` plans in `available_in_plans`. `gpt-6-luna` omits
`promax`, as does `gpt-6-sol`; Astra, GPT-6.1 Sol and GPT-6.1 Terra include it.

Pricing page: Plus $20/month; Pro from $100 ($100/$200/$500 tiers); Business
$20/user/month annual, $25 monthly.

Estimated local messages per 5 hours on Plus and Standard Business: Astra
5–45, GPT-6.1 Sol 15–160, GPT-6.1 Terra 35–285, GPT-6 Sol 15–150, GPT-6 Luna
350–3,000. Weekly limits may also apply. Pro states no five-hour limit and
gives no per-model figures. Enterprise and Edu with flexible pricing have no
fixed rate limits.

Fast mode costs 2.5x included usage (2x on credits). Ultrafast, offered on
Astra and GPT-6.1 Sol, costs 8x and is Pro $500 or eligible Enterprise only —
not Plus, not Business. The docs add that "some paid plans omit Astra Extra
High" without saying which.

GPT-6.1 Sol and GPT-6.1 Terra are Work/Codex only, not Chat. On Enterprise and
Edu, GPT-6.1 Sol stays off until an admin enables it.

No column in these rows depends on the plan.

## Observed — the Fast service tier

All four models advertise a Fast service tier in the bundled catalog, so all
four rows carry `fast-speed`. The `--fast` flag sets a `service_tier` of
`fast` on the Codex config for the turn.

## Inferred, not sourced

The following fields are copied from the `gpt-5.6-*` siblings on the same
route, not read from a provider statement: `provider`, `api`, `base_url`, the
zero cost columns, `reasoning`, `reasoning_effort_control`, the capability
set, the NULL architecture columns, and `active`.

`tier` is 2 for Astra, GPT-6.1 Sol and GPT-6.1 Terra to match the siblings.
`gpt-6-luna` is tier 1, inferred from its "most efficient" positioning and
"high-volume" role; OpenAI does not state a tier, and the tier vocabulary here
is ours.

The cost columns are 0 because the route is subscription-billed. A 0 in this
column set means "not reported", not "free to run": the operator's ChatGPT
subscription pays for it, and the receipt for a turn on this route still says
the USD cost was not reported.

## Not modelled

- Plan-tier usage limits, per-model message estimates and the Fast/Ultrafast
  multipliers above. The catalog carries no plan dimension.
- Reasoning-effort availability per model. The rows enable the control
  uniformly, as the siblings do.
- The three models the draft listed and this change did not add: `gpt-6-sol`
  (superseded generation of the Sol line, per the same superseded-generation
  rule that removed `gpt-5.6-*`), `gpt-5.5` (retired from Codex with ChatGPT
  sign-in on 2026-10-14 19:00 UTC), and the `visibility: hide` entries
  (`gpt-daybreak-blue-latest`, `gpt-daybreak-red-latest`, `codex-auto-review`).

## What this does not establish

- The canaries establish observed usable context windows for the signed-in
  runner on 2026-10-31. The 95% relationship to the published Codex figures
  is inferred; it does not establish a provider guarantee for every account
  or later run.
- Pricing and plan figures remain transcribed published information, not
  measured invoices or usage limits.
- Figures are point-in-time. This file is evidence for 2026-10-30 and
  2026-10-31.
