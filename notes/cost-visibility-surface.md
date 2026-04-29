# Cost-Visibility Surface — Design

Status: design note, pre-implementation.
Tracks: Active commitment #3 (README §10) — *"Define the cost-visibility surface: per-session running tally, pre-flight estimate on escalation to paid inference, hard/soft budget thresholds."*
Implementation home: Workbench first (`~/.dyfj/src/budget.ts` and the consent flow it feeds); the Project prototype follows where the design is publishable.

## Why a surface, not just a tracker

`BudgetTracker` already exists and works: per-tier accumulation, per-call and session limits, `budget_summary` event written at session end, `model_selected` events recording routing decisions, full `tokens_*` and `cost_total` columns on every `model_response`. The ledger is in place.

What's missing is the *surface* — the user-facing behavior that makes cost a design primitive rather than ledger data:

- *Before* a paid call: what does the principal see and decide on?
- *During* a session: what running state is visible without being asked?
- *At a soft threshold:* what can the principal do besides hit the wall?
- *Across sessions:* how is daily/task headroom represented?

The Goal-1 done-line says *"with cost visibility up front from the beginning, with confidence I'm not ripping through obscene amounts of token burn."* That's a UX claim, not a ledger claim. The tracker provides numbers. The surface is what makes those numbers part of how I work — and what makes "free from token-burn anxiety" a property of the system rather than a posture of the operator.

## Status quo

Inventoried so the surface design doesn't restate what's already shipped:

- `events` table — `tokens_input | tokens_output | tokens_cache_read | tokens_cache_write | cost_total` per `model_response`. `budget_summary` event ENUM exists.
- `models` table — canonical pricing per slug: `cost_input | cost_output | cost_cache_read | cost_cache_write` in USD per MTok, plus `tier`.
- `BudgetTracker.checkPreCall()` returns `{ allowed, estimatedCost, sessionCostSoFar, sessionLimitUsd, perCallLimitUsd, reason? }` — display-ready numbers, no display layer yet.
- `BudgetExceededError` halts on per-call or session-limit breach. Caller catches in `index.ts`.
- Tier semantics: `0` free / no consent · `1` session-grant consent (sticky once given) · `2` per-call consent (every time).
- Knobs today: `DYFJ_BUDGET_SESSION_USD` ($1.00), `DYFJ_BUDGET_PER_CALL_USD` ($0.10).

This is the floor. The surface stacks on top.

## Surface elements

### 1. Pre-flight escalation banner

Whenever the router selects a Tier ≥ 1 model, the consent flow displays a single banner:

```
→ Escalating to Claude Haiku 4.5  (Tier 1, session-grant)
   Reason:    code-shaped task; local Tier 0 declined for context length
   Estimate:  $0.0034 – $0.0180   (input ~3,400 tok; output multiplier 1.5×–5×)
   Session:   $0.0021 of $1.00   (0.2% used)
   Today:     $0.34 of $5.00     (6.8% used)
   Allow this session? [Y/n]
```

Tier 2 (per-call) shows the same banner every call. No session-grant path exists for Tier 2 by design.

**Decisions:**
- Estimate is a **range**, not a point. Input-only is a lower bound; we publish that explicitly with a plausible-output multiplier rather than letting a low number masquerade as the cost.
- Session **and** daily headroom are both visible. Daily catches the slow-bleed pattern session-only budgets miss — ten sessions at $0.50 each are all "within session budget" but aggregate to $5/day.
- The reason from `model_selected.content` surfaces here. Consent is informed by *why this tier*, not just *what it costs*.
- **Non-TTY contexts fail closed on Tier ≥ 1.** Without a TTY, no banner can be shown and no consent can be granted; the call is denied. CI, scripts, daemons explicitly opt out of paid inference unless they pre-pass an `--allow-paid` flag at invocation, which writes a `consent_granted` event for audit. Tier 0 always proceeds regardless of TTY.

### 2. Per-turn running tally

After each `done` event in a non-Tier-0 session, append a single-line tally:

```
$0.0034 this turn · $0.0058 session (0.6% of $1.00) · $0.34 today (6.8% of $5.00)
```

For Tier-0-only sessions the tally is suppressed (no spend, no signal). Configurable via `DYFJ_BUDGET_TALLY=on|paid|off` (default `paid`). Once a Tier-1 session-grant is given, the tally **stays visible** for the remainder of the session — it's the receipt of a decision already made, not redundant noise.

The tally is the receipt, not the alarm. It's there to make spend continuous-rather-than-discrete in your awareness, so the soft-warning thresholds aren't the first time you learn how the session is going.

### 3. Soft warning thresholds

Insert a soft warning when session or daily spend crosses a threshold (default 80%):

```
⚠ Session budget 82% used ($0.82 of $1.00). Continuing.
   Extend? Use --budget-session 2.00 on next call, or set
   DYFJ_BUDGET_SESSION_USD=2.00 in env (sticky across runs).
```

Soft warnings **never block**. They surface choice without forcing it. Hard stops remain at 100% — `BudgetExceededError`. Each crossing emits one `budget_warning` event for auditability; the threshold doesn't re-fire within a session.

### 4. Overrun rescue

When `checkPreCall()` returns `allowed: false`, current behavior is throw-and-abort. Replace with one interactive prompt at the boundary:

```
✗ Budget exceeded: session limit $1.00; this call would push to $1.04.
  Extend session budget to allow? [new total or n]:
```

Y or a typed amount continues with a written `budget_extended` event (auditability). Anything else aborts as today. Non-TTY contexts can't reach this prompt — Tier ≥ 1 was already denied at the pre-flight gate per Section 1, so overrun rescue is TTY territory by construction.

### 5. Multi-scope budgets

Today: session-only. Add **daily** scope as the next concrete bound — a single cap that survives `bun run` invocations.

Implementation: a query against `events` filtered by `principal_id` and `created_at >= TODAY()` summing `cost_total`. No new table — the events log already has everything needed.

```
DYFJ_BUDGET_DAILY_USD     (default $5.00)
```

`checkPreCall()` extends to consult both session and daily ledgers; whichever is tighter governs.

**Multi-process race protection (best-effort, not a lock).** Two concurrent `bun run` invocations can each pass a daily-headroom check at 99% used and both proceed, doubling the overrun. Cheap mitigation rather than a heavyweight lock: before any Tier ≥ 1 call, check whether *another* active session exists (events-log query — `session_start` rows without a matching `session_end` within the last hour) **and** daily spend is ≥ 75% of cap. If both, prompt the principal explicitly to confirm the call is intentional. Below 75%, the worst-case race overrun is bounded; above it, asking once is cheap insurance. Single-prompt-per-session — once acknowledged, sticky for that session. False positives (an unrelated DYFJ session in another shell) are intentional: they correctly surface "you have two sessions in flight; sure?" rather than mask coordination cost.

Task-scope and principal-scope budgets are deferred. They become real when there are multiple tasks-in-flight or multiple principals — neither is true today, and designing them now would be speculative.

### 6. Estimate accuracy

Replace the single-point input-only estimate with a `(low, high)` tuple:

- `low`  = `input_tokens × cost_input` (today's value)
- `high` = `low + (output_multiplier × input_tokens × cost_output)`
- `output_multiplier` defaults: Tier 1 chat **1.5** · Tier 1 reasoning **2.5** · Tier 2 reasoning **4.0**.
- Override per-model in the `models` table via a new optional column `output_estimate_multiplier DECIMAL(4,2) NULL` — NULL means use the tier default.

The pre-call check uses **`high`** for both per-call and session-headroom comparisons (conservative: prefer false-deny to false-allow). Banner displays both endpoints.

### 7. Discoverability

A read-only inspector that surfaces current state without invoking a model:

```
$ bun run budget
DYFJ Budget — 2026-04-29 17:43
  Session:    not active
  Today:      $0.34 of $5.00     (6.8% used, 7 sessions)
  Last 7d:    $1.92               ($0.27/day avg)
  By tier:    T0 free · T1 $1.45 · T2 $0.47
  By model:   gemini-2.5-flash $1.10 · claude-haiku-4-5 $0.35 · …
```

Minimum-viable version: read `events` + `models`, print the daily/7-day rollup. Iterates from there. The point is that "what have I spent?" is one keystroke away, not a Dolt SQL query.

## Cost metadata as discovery substrate

The same `models` columns that drive the cost surface — `tier`, `cost_input`, `cost_output`, `cost_cache_*`, `capabilities` — are also exactly the shape an agent registry needs for capability-with-budget lookup. A consumer asking *"give me a model where capabilities ⊇ ['code', 'reasoning'] **and** cost_output ≤ $5/MTok **and** active = true"* queries the same table the cost surface reads.

This is a quiet alignment with active commitment #2 (`register()` / `lookup()` interface stub, README §10). The static-config backing for that stub can be the `models` table itself — no new substrate, no parallel registry to keep in sync. When the runtime registry becomes real later, it inherits the schema rather than retrofitting it.

The lesson holds beyond models: **cost is a property of any callable thing in DYFJ** — agents, tools, models. As discovery extends to those, the same columns travel. The cost surface and the discovery surface share a substrate, the way audit and observability already share the events log.

## Schema implications

- New event types on the existing `event_type` ENUM:
  - `budget_warning` — soft threshold cross
  - `budget_extended` — overrun rescue accepted
  - `consent_granted` — per-call or session-grant decision (positive)
  - `consent_declined` — explicit negative
- New optional column on `models`: `output_estimate_multiplier DECIMAL(4,2) NULL`.
- New env vars: `DYFJ_BUDGET_DAILY_USD`, `DYFJ_BUDGET_TALLY`, `DYFJ_BUDGET_SOFT_THRESHOLD`.

No new tables. The events log + models table carry the entire surface.

## Implementation order

Smallest-to-largest, each independently shippable. Pick by lived friction, not by list order:

1. **Per-turn tally** — one print line off `BudgetTracker.getSummary()`. No schema change. ~30 min.
2. **Pre-flight banner** — replace whatever the consent flow prints today with the formatted banner. Pulls reason from the `model_selected` content the router already builds. No schema change. ~1h.
3. **Soft warning** — threshold check inside `record()`; emit `budget_warning` event + console line. Schema: ENUM extension. ~1h.
4. **Daily scope** — daily-spend query; extend `checkPreCall()` to consult it; surface in banner and tally. ~2h.
5. **Estimate range** — `(low, high)` tuple, multiplier column on `models`, conservative pre-call comparison. Schema: column + migration. ~2h.
6. **Overrun rescue** — interactive boundary prompt; `budget_extended` event. Schema: ENUM extension (already added in step 3 if bundled). ~1h.
7. **`bun run budget`** — read-only inspector against events + models. ~2h.

Approximate total: ~10h. No piece is required for the next; ship in any order driven by what you actually feel in daily use.

## Out of scope (v1)

- Task-scope and principal-scope budgets. Real when there's more than one of each.
- Cost forecasting ("at current rate you'll exhaust daily budget in ~2h"). Nice, not required.
- Budget UI inside the future block-rendering pane. The pane is its own project; this surface is CLI-shaped on purpose.
- Reconciliation against provider invoices. Back-office concern, not a session-time concern.

## Open questions

- **`consent_*` event payload completeness.** When a `consent_granted` or `consent_declined` event is written, what goes in `content` — just the decision, or the full displayed banner including the estimate range, headroom snapshot, and routing reason? Argument for full banner: audit completeness and after-the-fact reconstruction of *what the principal saw when they decided*. Argument against: log-size growth on consent-heavy sessions. Lean: full banner; storage is cheap, audit clarity is not.
- **`bun run budget` as an MCP tool.** Should the inspector also be exposed as an MCP server tool so other agents can ask *"how much have I spent today?"* without invoking a model? Same data, two surfaces. Probably yes once a second consumer exists; not yet.
- **Daily cap timezone behavior.** "Today" anchored to `created_at >= TODAY()` in Dolt server time. Travel and DST will produce surprises. Defer until it bites; document assumption when shipping.

## See also

- README §1 — Layer 0 stance #5 (cost visibility as a default, not an add-on).
- README §2 — Goal 1 done-line.
- README §6.3 — Cost & budget machinery as cross-cutting concern.
- `~/.dyfj/src/budget.ts` — the tracker this surface drives.
- `~/.dyfj/schema/006_models.sql` — pricing source of truth.
- `~/.dyfj/schema/008_events_budget_summary.sql` — summary event already in the ENUM.
- `~/.dyfj/schema/007_events_model_selected.sql` — routing decisions surfaced in the banner.
