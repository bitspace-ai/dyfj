# Backlog — external-agent (ACP) lane

**Status:** retired from the runtime (decision D17, work order WO-00). The code
lives in git history. The last commit containing it is recorded here by WO-00.

**Last commit with the lane:** _to be filled in by WO-00_.

## What it was

A second execution lane beside the native model loop. The Workbench acted as an
Agent Client Protocol (ACP) client and ran an external agent (a fixture agent,
and a Codex adapter using subscription authentication) as a supervised child
process:

- outer protocol evidence was recorded, and the agent's internal state was
  treated as opaque;
- permission requests were relayed to the operator;
- continuity was tracked across warm-reused, reconstructed and resumed sessions.

## Why it was retired

The goal was access to frontier models through existing subscriptions. The cost
was weight that couldn't be opened up:

- **Dependencies:** an adapter pinned to one exact version, a vendor agent
  binary pulled in as an npm dependency, a dedicated authentication home, and
  toolchain provisioning.
- **Code:** about 4.5k lines of runtime and 6k lines of tests.
- **Cost accounting:** usage and cost could only be labelled as "ACP evidence",
  not accounted for like native calls. That sits badly with Layer 0 stances #2
  and #5.
- **Architecture:** it caused an import cycle, a duplicated routing preflight,
  and a second lifecycle for per-session state.

It was a banana-gorilla-jungle trade: asking for the model brought along the
vendor's whole agent harness.

## Re-entry criteria

Re-open this only when all of these hold:

1. **Cost visibility before spend.** The lane can show cost posture before a
   call and receipt the call afterwards, at the same fidelity as native calls,
   or an explicit, operator-visible "unmetered" posture that the budget
   envelopes treat as a decision rather than a default.
2. **Bounded weight.** The dependency surface is bounded and pinned. No vendor
   binary is fetched implicitly as a transitive dependency.
3. **Fits the architecture:**
   - it enters behind `resolveRoute` (which then gains a `Runner` interface);
   - it uses the `SessionOwner` for any per-session handle;
   - it writes only through the journal;
   - it adds no import cycles.
4. **Golden coverage.** A golden scenario pins it before it ships.
5. **Phase-2 fit.** The phase-2 contract already models an external route lane
   (RouteSpec). Re-entry should land as that lane, not as a parallel mechanism.
