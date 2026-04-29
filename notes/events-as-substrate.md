# The Events Table as Shared Substrate

Design note. *How DYFJ's cross-cutting concerns — observability, auth/authz, capability discovery, cost — share one append-only log instead of getting their own services.*

---

## The frame

DYFJ's `events` table is not a logging table. It is the **shared substrate** that every cross-cutting concern projects onto. There is one append-only log, and every concern — telemetry, auditability, discovery, budget — is a *lens* over that log, not a separate store with separate writers and readers.

This is the deepest architectural commitment in DYFJ. Once you see it, the schema stops feeling like "we keep adding metadata fields" and starts feeling like "every column is a perspective from which the same action can be queried."

The Layer 0 stance "schema lives in the data layer" is what makes this work: there is exactly one canonical event shape, defined in DDL, and every concern that wants a view writes/reads the same rows. No concern owns its own store. No concern owns its own write path. The log is the integration point.

---

## Producers and consumers

The mental model is producer/consumer over a shared append-only log. Both sides do exactly one thing.

**Producers** are anyone who DOES something and writes an event row. Agents, skills, services, the model itself, the cost-aware router, the consent flow. Every producer's interface is the same: `events::write(pool, &event)`. They produce structured records of "this happened, at this time, by this principal, in this trace, to this resource, on this authority, with these cost/capability/tool details where relevant."

**Consumers** are processes (or library functions) that READ slices of the log to compute a view. Each cross-cutting concern is a different consumer:

- **Observability consumer** — reads `trace_id` / `span_id` / `parent_span_id` to reconstruct distributed traces. Could be an OTel exporter shipping to Honeycomb. Could be a DataGrip query for ad-hoc trace inspection. Could be an MCP-exposed query for an agent debugging itself.
- **Audit consumer** — reads `principal_id` / `principal_type` / `action` / `resource` / `authz_basis` to answer "who did what, when, on what authority." A compliance report generator, an audit log viewer, a forensic query.
- **Capability-discovery consumer** — reads `event_type='capability_provide'` rows where the lease has not expired to answer "who currently provides capability X." This is the registry. It is a *projected view* over the immutable log, not a separate store.
- **Cost consumer** — sums `cost_total` over `model_response` events for budget tracking, sliced by session, principal, model, or time window.

These consumers don't conflict because the log is append-only and each concern has its own indexed columns:

- `idx_trace (trace_id, span_id)` for the observability lens
- `idx_principal (principal_id, principal_type, created_at)` for the audit lens
- `idx_capability_name (capability_name, event_type, capability_lease_expires)` for the discovery lens
- (Cost analysis uses `idx_event_type (event_type, created_at)` plus the model index)

Same table. Different lenses. Different indexes carry the queries each lens needs.

---

## Each cross-cutting concern is a lens

| Concern | Source columns | Lens output | Today |
|---|---|---|---|
| **Observability** | `trace_id`, `span_id`, `parent_span_id`, `created_at`, `duration_ms` | Distributed traces, span tree visualizations, latency profiles | Schema present, populated by callers, no exporter built |
| **Auditability** | `principal_id`, `principal_type`, `action`, `resource`, `authz_basis` | "Who did what when on what authority" | Schema present, populated by callers, no audit UI built |
| **Capability discovery** | `event_type IN (capability_*)`, `capability_name`, `capability_version`, `capability_lease_id`, `capability_lease_expires`, `capability_metadata` | "Who currently provides X / who needs X / what's bound to what" | Schema present, no producer + no consumer yet |
| **Cost & budget** | `model_id`, `provider`, `tokens_*`, `cost_total` | Per-session/per-principal/per-model spend rollups, budget thresholds | Partial — schema present, prototype router populates, no consolidated surface |

Notice what's the same in every row of this table: *schema in the data layer, populated by producers, projected by consumers, no separate store*.

Notice what's different: each concern is at a different stage of having actual producers and consumers wired up. The schema is the easy part. The actual machinery comes later, per concern, when there's a real reason to build it.

---

## Capability discovery, specifically

This is the concern we just shipped schema for, and the one I had the most uncertainty about. Walking it through three times — today, tomorrow, later — makes the picture concrete.

### Today (the shape exists; behavior does not)

The schema supports four event types:
- `capability_provide` — "I can do X, until time T, version V"
- `capability_require` — "I need X, by time T, version V or above"
- `capability_match` — "the registry bound this require to that provide" (carries `capability_lease_id` referencing the originating provide's `event_id`)
- `capability_release` — "the lease is over"

Plus five typed columns: `capability_name`, `capability_version`, `capability_lease_id`, `capability_lease_expires`, `capability_metadata`.

The Rust library (`events::write` / `events::read_by_id`) reads and writes these fields. The integration test (`capability_round_trip.rs`) proves they survive a Dolt round-trip.

That's it. Nothing announces. Nothing discovers. No matcher. No registry process. The capability_provide row from the test is sitting in Dolt right now, expired, unread. **Today, the substrate is shape, not behavior.**

This is the correct state of the world. Day-1 schema is committed because it's expensive to retrofit. Behavior is not committed because it's cheap to add when there's a real consumer.

### Tomorrow (a thin `register()` / `lookup()` stub)

The next architectural commit named in README §10 is two Rust functions:

```rust
pub async fn register(pool: &MySqlPool, capability: CapabilityAdvertisement) -> Result<()>;
pub async fn lookup(pool: &MySqlPool, capability_name: &str) -> Result<Vec<CapabilityProvider>>;
```

These are not a registry service. They are not a daemon. They are not even a separate process. They are **thin wrappers** over `events::write` and a single SQL SELECT.

`register()` is essentially:
```
write a capability_provide event with the right shape
```

`lookup()` is essentially:
```
SELECT principal_id, capability_name, capability_version, capability_lease_id
FROM events
WHERE capability_name = ?
  AND event_type = 'capability_provide'
  AND (capability_lease_expires IS NULL OR capability_lease_expires > NOW(6))
ORDER BY created_at DESC
```

That's the registry. It's two functions over a query against the index we already added. There is no separate process holding state. The state IS the log.

The phrase "static-config backing" in README §10 means: until the function signatures need to support fancier things (federation, cross-process leasing, heartbeats), the implementation is just function calls reading and writing the same Dolt the rest of DYFJ uses. Static-config doesn't mean "we hardcode capability lists in TOML"; it means "the function shape supports a future runtime registry, but the implementation is just SELECTs."

### Later (when a real registry process might emerge)

Eventually — possibly never, possibly years from now — the registry might become its own process. Reasons it might:

- Cross-process leasing with heartbeats (provider crashes, lease auto-expires within seconds, not minutes)
- Federation across nodes (this Mac, Sleipnir, whatever else)
- Active matching that proactively binds requires to provides without a consumer asking
- Subscription-style "notify me when capability X becomes available"

When that day comes, the registry process is **still just a producer and consumer of the same events table.** It writes `capability_match` and `capability_release` events. It reads `capability_provide` and `capability_require` events. It owns no separate store. The substrate doesn't change. The registry-as-process is one more lens with extra behavior wrapped around it.

This is the deep version of "no service" — even when a registry service eventually exists, it doesn't replace the log; it sits on top of it.

---

## Skills, ephemeral UIs, and agents are all the same primitive

This is the part I noticed independently from the substrate work, and it's worth stopping on, because it's the architectural payoff of getting the substrate right.

Agent skills *are* a progressive-disclosure mechanism. They're declared with metadata describing trigger conditions; the harness loads them only when a request matches. Now look at how that maps to capability discovery:

| Skill model | Capability model |
|---|---|
| Skill registration (declaring triggers + metadata) | `capability_provide` event |
| Skill matching (trigger conditions match user input) | `lookup()` returning a provider |
| Skill invocation (harness loads + executes) | `capability_match` event |
| Skill lifetime / load semantics | Lease window |
| The harness's skill matcher | The registry/lookup function |

These are not two different ideas at two different layers. They are the **same idea at different altitudes.** Skills are one *consumer* of the capability/discovery substrate.

So is ephemeral software (the dashboards-on-demand from earlier this session). The agent generating a slider is announcing a short-lived capability ("I provide this UI surface"); the user dismissing it is releasing the lease ("the surface is no longer available").

So is inter-agent matching. Agent A advertises `memory.search.semantic`; agent B requires it; the matcher binds them.

The substrate doesn't care who the consumer is. `principal_type` is `'human' | 'agent' | 'service'` — generic by design. The capability vocabulary is dotted-hierarchy strings — also generic. A skill announcing itself, an agent advertising tool calls, an ephemeral UI registering its slider: **all the same shape.**

This is what "swappable with strong defaults" means in operative terms. The substrate is one thing. The consumers are many things. New consumers don't require new substrate; they just write and read the same log.

---

## How fields get populated, per concern

Different fields get populated by different producers, at different points in the agent loop.

**OTel fields (`trace_id`, `span_id`, `parent_span_id`):**
Populated by an instrumentation layer when each operation begins. Today, the caller of `events::write` passes them by hand. Future: a `SpanContext` object threads through the agent loop, and `events::write` reads the current context automatically.

**Identity / authz fields (`principal_id`, `principal_type`, `action`, `resource`, `authz_basis`):**
Populated by whoever's calling `events::write`. Today these are just strings the caller passes ("rook", "agent", "advertise", "memory.search.semantic", "test"). Future: a policy engine intercepts every operation, makes an allow/ask/deny decision, and `authz_basis` records WHY it was permitted ("policy:allow-local-fs", "user_consent:session-123", "capability_grant:lease-01HX...").

**Capability fields:**
Populated by the producer announcing or requesting capability state. Today, only the integration test calls these. Tomorrow, `register()` is the canonical entry point — agents call it on startup or when their state changes; the function writes the right `capability_provide` row with sensible defaults. Later still, the matcher writes `capability_match` rows when it binds requires to provides.

**Cost fields (`tokens_*`, `cost_total`):**
Populated by whoever ran the model call — typically the cost-aware router, which knows the spend at the moment of the call. Already partially populated by the prototype's router for `model_response` and `model_selected` events.

Every field has a producer. Every field has a consumer. Producers don't have to know about consumers; consumers don't have to know about producers. They meet at the table.

---

## Why there's no registry service

The anti-pattern is treating each cross-cutting concern as a service that needs its own store, its own write path, its own consistency model. That's the path most distributed systems go down. It produces a fleet of small services, each with its own schema, its own retention policy, its own failure mode, and a tangle of integration points between them.

DYFJ rejects this for one reason: **the events table is already the integration point.** Every concern is describing the same actions from a different angle. If you give each concern its own store, you have to integrate them. If they all share one store, integration is the schema.

This is also why `register()` and `lookup()` are deferred until there's a consumer. A registry built without consumers is a registry built on guesses. The shape we'd lock in — sync vs. async, push vs. pull, eager vs. lazy match — would all be guesswork. The right forcing function is a real agent, doing real work, hitting a real "I need to discover X" moment. Then the API designs itself.

The Jini lineage matters here. Sun's Jini got bilateral capability discovery right thirty years ago: lookup, leasing, capability/need matching as substrate primitives. DYFJ borrows the *shape of the question* (per the README's Influences section), not the protocol. The shape is: one substrate, many participants, all reads and writes go through it. Not many services with their own state.

---

## When the registry stub gets built

The forcing function is a real consumer. Specifically, when one of these happens:

1. An agent (Rook, or whatever) is doing real work and reaches for a capability it doesn't have hardcoded knowledge of. *"I want to call memory.search.semantic but I don't know which provider to route to."* That's the moment `lookup()` earns its first call site.

2. An ephemeral UI surface (the post-VT100 pane / DYFJ Workbench surface) needs to register itself so the rest of the system knows it's there. *"I just spawned a slider; future calls to ui.render.slider should route to me."* That's the moment `register()` earns its first call site.

3. A skill consolidation — DYFJ deciding that skills should announce themselves as capabilities rather than be discovered through harness-specific declarations. *"My harness's skills are just one form of capability provider; let's unify."*

Until one of these forces it, building `register()` and `lookup()` is premature. The schema is already in place — that's the cheap-now-expensive-later commitment honored. Behavior comes when behavior is needed.

---

## Implications for downstream architecture

Holding this frame changes how you reason about new requirements:

- "We need observability" → not "build an observability service," but "what query over events gives us this lens."
- "We need audit logs" → not "build an audit log table," but "what query over events gives us this lens."
- "We need a tool registry" → not "build a tool registry service," but "what query over events gives us this lens."
- "We need cost tracking" → not "build a billing pipeline," but "what query over events gives us this lens."

This is the unification. Every downstream architectural question becomes "what's the projection?" not "what's the new service?"

It's also why the daily-driver discipline matters. By actually using DYFJ end-to-end, you'll bump into real "I need to know X about my work" moments. Each one becomes a query, not a feature. The substrate doesn't change. The lenses accumulate.

---

## See also

- README §1 — the Layer 0 stances, especially "schema lives in the data layer" and "swappable with strong defaults."
- README §6 (Architecture — tiered primitives) — Layer 1 names "Inter-Agent Contracts & Capability Discovery" as a subsystem; this design note is the elaboration.
- README §10 — Active commitments, including the deferred `register()` / `lookup()` stub.
- `schema/001_events.sql` — the canonical event row.
- `schema/010_events_capability.sql` — the capability/discovery columns and the four event-type extensions.
- `notes/tracer-bullet.md` — the previous design note (substrate plumbing through Rust).
- `core/src/events.rs` — the producer side of the API.
- `core/tests/capability_round_trip.rs` — the proof that the capability fields survive a Dolt round-trip.
