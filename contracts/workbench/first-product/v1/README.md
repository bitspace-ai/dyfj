# Workbench first-product semantic contract package, v1

Package version: `workbench.first-product/v1`. Entry point:
[`validate.ts`](validate.ts).

This directory freezes the first-product **semantics** of the Workbench domain:
rooms, participants, memberships, threads, agent specifications, tasks, runs,
routes, capability reports, context packets, grants, leases, artifact
references, events, projections, receipts, route control, labels, claim sources,
and authority. It ships the schemas that state those semantics, the validator
that enforces them, and a synthetic fixture corpus that demonstrates both what
the contract accepts and what it rejects.

## Semantic contract, not runtime authority

This package is a **semantic and validation boundary**. It is not a runtime.

- It implements no persistence, routing, process control, user interface, or
  provider integration, and it grants no capability to anything that runs.
- The repository's Dolt DDL under `../../../../schema/` remains the canonical
  data-layer schema for implemented durable state (README Section 1, Layer 0
  stance #4). This package defines the contract that later data-layer work
  consumes; it does not replace that authority with TypeScript or JSON Schema.
- <!-- closure-claim: document-validation-boundary --> Validating a document
  here proves the **document**. It proves nothing about runtime conformance,
  operator acceptance, publication readiness, or any behaviour of the
  implemented Workbench.

## Layout

```text
contracts/workbench/first-product/v1/
  README.md            this document
  validate.ts          package entry point: version, rule inventory, validator
  json-schema.ts       dependency-free JSON Schema 2020-12 subset evaluator
  semantic-rules.ts    cross-document, lifecycle, label, and authority rules
  validate.test.ts     focused contract tests over the fixture corpus
  executable-closure-manifest.json
                       fixed 24-target / 61-invariant / 31-probe denominator
  executable-closure.test.ts
                       preserved counterexample oracle
  executable-closure-report.ts
                       deterministic report generator and self-check
  positive-witnesses.ts
                       explicit allowed-branch witness table
  executable-closure-report.json
                       generated closure evidence for the source candidate
  schemas/*.json       JSON Schema 2020-12 documents (one corpus root)
  fixtures/positive/   corpora the contract must accept
  fixtures/negative/   corpora the contract must reject, one rule each
```

The package adds no dependency. Structural validation runs on a repository-owned
evaluator that supports exactly the keywords these schemas use. Support is
decided **at registry construction**: the authoring audit walks every
schema-bearing location of every registered document — `$defs`, `properties`,
`items`, schema-valued `additionalProperties`, and each `allOf` / `anyOf` /
`oneOf` branch — and rejects an unsupported keyword or a malformed keyword value
even in a branch no document ever reaches. Checking only what an instance
happens to visit would let an unsupported keyword sleep inside an optional
subschema, and a misspelt keyword value (`"required": "id"`, `"minItems": "2"`)
would silently assert nothing. `const` and `enum` members are data, not schemas,
and are never traversed.

Every fixture is one `dyfj.workbench.first-product.corpus/v1` document. The
`first-product-solo-operator` profile additionally requires the persistent
solo-room defaults and the full deferral inventory; the `focused-rule-fixture`
profile carries only what a single rule needs.

## Validator boundary

**JSON Schema** enforces shape: required fields, version identifiers, value
domains, reference shapes, bounded collections, closed objects, and the declared
structural alternatives. Task and Run states are separate schema types with
disjoint vocabularies (`task:` and `run:` prefixed), so a Run state can never be
stored where a Task state belongs.

The alternatives are enforced, not merely described. Each payload representation
owns exactly its companion form; the three speak policies are three distinct
shapes; a `task-branch` thread names its task; a context source and an
authoritative artifact reference are internal _or_ external and never both;
version evidence carries the companion its kind names; a participant is
independent of exactly the four declared dimensions; and a route requires lane,
modality, model, adapter, policy basis, and cost basis, plus at least one of
runner or provider. Lane identifies loop ownership — native means Workbench owns
the loop, external means an ACP-wrapped harness owns its inner loop — and it
does not decide whether runner or provider is forbidden: a native hosted route
can require a provider, an external route can require a runner, and a faithfully
observed route can record both. An event body is inline or a governed artifact
reference and never both, but an event family with no body carries neither:
envelope fields apply _as applicable_, so this is not a global exclusive choice.

<!-- closure-claim: semantic-contract-behavior --> **TypeScript**

(`semantic-rules.ts`) enforces what shape cannot express: reference closure and
entity-kind correctness, stable-identity rules derived from the declared
identity basis, lifecycle state-type separation, the required progression and
its conditional edges, run-caused-consequence evidence, state-and-event pairing,
per-Task run-attempt uniqueness, revision and causal ordering, label and
claim-source preservation across context entries, summaries, projections, events
and receipts, route-phase ordering, route binding, run evidence binding
(exclusive ContextPacket ownership, agent-specification agreement, effective
grant lineage and scope, and Task route, capability, workspace, tool, and budget
requirements), capability rejection before spend or action, continuity evidence
matching the claimed continuity class, effective authorization basis and task
envelope authority, approval ordering before reliance, the deterministic
private-and-untrusted-and-egress grant policy, sole-writer authority per event
family and cutover, grant principal continuity, durable-commit evidence before
authority-bearing acknowledgement, receipt family requirements and receipt
subject reconciliation, absence of inline secret payload from ordinary events
and receipts, and explicit deferral without accidental first-product
requirement.

## Authority is effective, not syntactic

Naming an authorization is not being authorized, so the validator checks the
authorization rather than the claim:

- A grant-authorized event names a grant that resolves, and that grant's grantee
  is the event's own author.
- An authority-bearing event does not rest on a `denied` policy decision.
- An `allowed-with-approval` basis resolves to a real, human-authored approval
  event. The same holds for a grant or a route once the corpus draws authority
  from it. <!-- closure-claim: operator-direct-evidence --> A machine-authored
  `operator-direct` event likewise resolves to a preceding, attributable,
  human-authored authorizing event for the same Task or Room.
- A Task reaches `task:completed` only under an approved envelope, and a
  grant-authorized completing transition uses that envelope's grant. The
  approval flag has no attributable approval-event reference, so that authority
  remains an explicit report residual rather than a passing claim.
- A superseding grant keeps both principals. Changing the grantor or grantee
  starts a new lineage rather than revising the old grant.
- A grant whose scope allows network reach and names an egress-capable
  destination class cannot be relied on by a Run that consumes content that is
  simultaneously private (carries a secrecy tag) and untrusted unless the grant
  carries the specific secrecy/integrity authorization — the deterministic
  private-and-untrusted-and-egress policy.
- A conditional grant's or route's approval must be recorded no later than the
  grant's or route's first reliance; an approval that postdates use carries no
  authority.
- Within a declared event family, the first writer a corpus names is that
  family's cutover writer; every later family event must name that writer. A
  different or omitted post-cutover writer is rejected. Events before the first
  writer declaration remain explicit pre-cutover history.

<!-- closure-claim: route-control-binding --> Route control is bound the same

way: a session, the Run it serves, and the capability report its `prepare` phase
reads all name one route, and a Run that names a session names that session. A
session that reaches spend or action has an accepted `prepare` with its own
capability report — the unavailable-required posture is read from that report
alone, never from some other phase's report. None of this implements routing; it
constrains what a document may claim about it.

## Receipts are reconciled against their subjects

Every receipt names the durable receipt-family event that committed it, and its
fields are checked against the entities and the history they describe. State and
revision are reconstructed **at the commit event's sequence**, not compared to
final corpus state: the baseline turn receipt truthfully records a running Run
that a later event interrupts, and a final-state comparison would call that a
lie. <!-- closure-claim: receipt-evidence-binding --> Task and Run association,
the family's subject, the Task and Run revisions in the body, route-to-Run
binding, packet-to-subject binding, packet revision and digest, projection
revision and output digest, and capability report route, revision, and
unavailable-required posture are all reconciled. A Run receipt also records and
reconciles the Run's Route, ContextPacket, and capability posture.

Capability reports are treated as immutable versioned observations within a
corpus, which is why a receipt's posture binds `report_revision`; no report
history is persisted here. A completion receipt's acceptance and closure facts
point at the receipt Task's own operator-accepted transition events. An
accepted-then-closed Task requires an `accepted` fact; a directly closed Task
instead requires the bound human operator decision without implying acceptance.
No evidence a receipt names — its own `evidence`, route evidence, verification
evidence, or completion-fact evidence — may postdate the receipt's own commit
sequence, and a receipt's commit event may not name a Task or Run other than the
receipt's own.

A turn receipt's primary subject is the room/thread conversational exchange: it
carries `current_state` only when a Run participates and must reconcile that
Run's lifecycle state, and omits `current_state` entirely rather than inventing
a synthetic Run or a room/thread state machine when no Run is present. Run,
interrupt, and completion receipts always carry `current_state`; Run and
interrupt receipts name both their Task and Run, while a completion receipt
names its Task and any Run that actually participated.

## Executable closure report

An HTML comment of the form `<!-- closure-claim: <id> -->` marks the sentence
whose claim the report generator traces to supporting invariant results. Only
sentences with these markers are traced; unmarked prose lies outside the trace.

<!-- closure-claim: explicit-positive-witnesses --> The generated

`executable-closure-report.json` is the package-level evidence surface. It
enumerates EC-001 through EC-061 exactly once, preserves every RP-01 through
RP-31 disposition (including both branches of conditional probes), rolls the
evidence up across T01 through T24, maps stable validator rules to invariant
authority or structural safety, and fails closed when an identifier or required
witness is missing. The checked-in `positive-witnesses.ts` table names an
executed accepted fixture or distinct accept-branch probe for every invariant
and every allowed conditional branch. The generator also evaluates mutated
copies of its observed evidence to prove that omitted identifiers, witnesses,
mutation classes, and unsupported public claims fail the report. `blocked` and
`not-applicable` are valid only when the generator observes a stated residual; a
required identifier, witness, mutation class, or declared claim marker absent
from the generator's observed evidence is never reported as `pass`. Its
candidate identity is the contract source manifest, which deliberately hashes
the contract source tree without the generated report itself, avoiding a
self-referential digest; the report's own digest binds the generated output.

The report generator and self-check run under the repository's existing
`test.aggregate` gate in both fast and full modes. A green report proves this
declarative corpus and its oracle only. The final aggregate-gate receipt remains
the evidence that every repository lane actually passed for the exact candidate;
neither artifact proves runtime conformance or grants runtime authority.

Deliberately absent: a general policy engine, an information-flow lattice, a
persistence layer, a route adapter, and any runtime authority. Label comparisons
are fixed ordinal checks over the declared label vocabulary.

Two properties hold by construction:

- **Structural findings gate semantic ones.** A malformed document is reported
  under a structural rule only; no cross-document conclusion is drawn from a
  document whose shape is wrong.
- **Diagnostics are deterministic and value-safe.** A finding carries a stable
  rule id, a sanitized JSON pointer, code-authored detail text, and at most an
  entity id that already passed the identifier pattern. No fixture payload byte
  reaches a diagnostic line, and the test suite asserts that.

## Lifecycle: what is encoded and what is not

<!-- closure-claim: lifecycle-behavior --> The required Task progression is

encoded exactly as the accepted contract states: `proposed` → `ready` →
`running` → (`waiting` | `blocked`) → `completed` → (`accepted` | `closed`),
with `waiting` and `blocked` optional detours that must return to `ready` or
`running` before completion, and both `waiting` and `blocked` return to either
`ready` or `running`. Two edges are conditional rather than unconditionally
available: `running` → `ready` requires a failed or interrupted Run with
preserved causal evidence naming it, and `completed` → `closed` requires an
explicit, attributable, human-authored operator decision and never asserts or
implies acceptance. A failed, interrupted, abandoned, or superseded Run never
ends its Task by itself — ending it requires a separate operator decision — and
every such Run must leave a recorded causal consequence on its Task (a recovery
or an operator-decided ending that cites it), never a silently absorbed failure.

The exhaustive exceptional-state graph is **not** settled architecture and is
not invented here. A transition declares a `progression_class`:

- `required` — the edge must be in the encoded required progression.
- `exceptional` — the target must be an explicit exceptional outcome
  (`interrupted`, `failed`, `rejected`, `superseded`, `abandoned`), and may
  never be `completed`, `accepted`, or `closed`. Which exceptional edges are
  reachable from which states is left open on purpose.

Each transition is judged most-specific-rule-first (run independence, then
outcome collapse, then required progression) and reports at most one rule, so a
fixture proves the violation it names rather than a derived one.

## Ordering scales

<!-- closure-claim: ordering-evidence --> Two independent monotonic scales

appear in the corpus, and neither is a wall-clock claim:

- `event.sequence` orders events; causal parents and superseded events precede
  their successors.
- `durable_commit.commit_sequence` is non-decreasing in `event.sequence` order,
  while `acknowledgement.sequence` orders acknowledgements. An authority-bearing
  acknowledgement may not precede the commit it depends on.

Event `at` timestamps are descriptive and non-authoritative. Ordering authority
comes only from `event.sequence` and `durable_commit.commit_sequence`.

The frozen executable-closure manifest still contains private authority-record
digests. They cannot be changed in this correction; replacing them with a public
authority reference requires an operator-approved, versioned re-freeze. The
generated report and other mutable public surfaces expose only the package
version and state that the authority-record digest is recorded privately.

## Deferrals

<!-- closure-claim: deferral-boundary --> These are recorded as **not required**

for the first product. A deferral record may reserve a forward-compatible
identifier or event-family name; it never makes the capability required,
implemented, routable, or authoritative, and the validator rejects a deferred
capability that reappears as an available tool, granted resource, or required
route capability:

- child agents and recursive delegation;
- durable promoted memory across rooms;
- `MemoryClaim` implementation (the name `memory-claim` is reserved only);
- peer synchronization or distributed consensus;
- external messaging bridges;
- additional center surfaces beyond the conversation, activity, status, and
  inspector projection families;
- online self-modification or optimizer-controlled promotion;
- route feature parity; and
- a new distributed deployment topology.

Two further boundaries are held open on purpose: adapter-specific
`ContextPacket` projection fields and golden cross-adapter fixtures belong to a
later tranche, and the process-provenance family here is a generic event family
plus a typed extension point (`tranche_status: "not-frozen"`) — detailed
discovery candidates, selected skill revisions, execution topology, and
source-corpus evidence are not frozen by this package.

## Stable rule inventory

Structural rules: `structure.required`, `structure.type`,
`structure.value-domain`, `structure.unknown-field`, `structure.collection`,
`structure.mutual-exclusion`.

Semantic rules: `identity.stable-basis`, `identity.uniqueness`,
`reference.closure`, `reference.kind`, `lifecycle.state-type`,
`lifecycle.progression`, `lifecycle.outcome-collapse`,
`lifecycle.run-independence`, `lifecycle.transition-event-pairing`,
`lifecycle.revision-order`, `lifecycle.run-attempt-uniqueness`,
`event.causal-order`, `solo-room.defaults`, `solo-room.loop-prevention`,
`label.preservation`, `label.clearance`, `provenance.preservation`,
`route.phase-order`, `route.capability-rejection`, `route.binding`,
`route.continuity-evidence`, `route.native-extension-authority`,
`route.native-capability-erasure`, `authority.durable-commit`,
`authority.async-source`, `authority.basis`, `authority.task-envelope`,
`grant.no-self-broadening`, `grant.principal-continuity`,
`lease.availability-only`, `receipt.family-requirements`,
`receipt.subject-reconciliation`, `claim-source.separation`,
`secrecy.inline-secret`, `deferral.not-required`, `deferral.inventory`,
`run.evidence-binding`, `grant.egress-policy`, `authority.sole-writer`.

## Fixtures

`fixtures/positive/first-product-baseline.json` is the whole contract in one
corpus: one persistent operator room with an operator and a primary agent, one
task carried through the required progression to closure, two independent run
attempts (the first interrupted and retained, the second completed on a
different route), ordered route phases with truthful continuity evidence, a
compacted context packet and a derived artifact that both preserve their source
labels, a projection under consumer clearance, an expired native-session lease
that removes availability without touching identity or history, turn, run,
interrupt and completion receipts with separate attribution and claim sources,
and the full deferral inventory.

The positive acceptance matrix (`P1`–`P9`) is decided by **test-owned
predicates** that go looking for those witnesses in the corpus, not by the
fixture's own `proves` list. `proves` is display metadata: it says what a
fixture is for, and it survives the deletion of the very thing it claims. The
suite states that directly — it takes one witness away per matrix item, leaves
`proves` untouched, and requires the corresponding predicate to fail.

`fixtures/positive/focused-minimal-corpus.json` is the control for the negative
corpora: the same shape, no violation.

Each negative fixture names the stable rule id it must be rejected for. The
suite fails if a negative fixture is accepted, if it is rejected for any rule
other than the one it names, or if any stable rule id in the package's own
inventory has no negative fixture naming it — the oracle is the full rule
inventory (`RULE_IDS`), never a hand-picked subset and never the fixtures' own
`proves` claims:

| Fixture                                                     | Rule                                 |
| ----------------------------------------------------------- | ------------------------------------ |
| `01-missing-stable-identity`                                | `structure.required`                 |
| `02-malformed-stable-identity`                              | `structure.value-domain`             |
| `03-process-derived-identity`                               | `identity.stable-basis`              |
| `04-run-state-used-as-task-state`                           | `lifecycle.state-type`               |
| `05-task-closed-because-one-run-failed`                     | `lifecycle.run-independence`         |
| `06-state-mutation-without-event`                           | `lifecycle.transition-event-pairing` |
| `07-event-claims-absent-mutation`                           | `lifecycle.transition-event-pairing` |
| `08-interruption-recorded-as-completion`                    | `lifecycle.outcome-collapse`         |
| `09-projection-drops-source-labels`                         | `label.preservation`                 |
| `10-projection-exceeds-consumer-clearance`                  | `label.clearance`                    |
| `11-derived-artifact-drops-provenance`                      | `provenance.preservation`            |
| `12-unavailable-capability-reaches-spend`                   | `route.capability-rejection`         |
| `13-invalid-route-phase-transition`                         | `route.phase-order`                  |
| `14-unsupported-continuity-claim`                           | `route.continuity-evidence`          |
| `15-shared-report-erases-native-capability`                 | `route.native-capability-erasure`    |
| `16-lease-expiry-deletes-identity`                          | `lease.availability-only`            |
| `17-acknowledgement-before-durable-commit`                  | `authority.durable-commit`           |
| `18-inline-secret-in-event-payload`                         | `secrecy.inline-secret`              |
| `19-collapsed-claim-sources`                                | `claim-source.separation`            |
| `20-run-receipt-missing-family-evidence`                    | `receipt.family-requirements`        |
| `21-deferred-capability-marked-required`                    | `deferral.not-required`              |
| `22-machine-event-summons-another-agent`                    | `solo-room.loop-prevention`          |
| `23-grant-revision-broadens-itself`                         | `grant.no-self-broadening`           |
| `24-unresolved-required-reference`                          | `reference.closure`                  |
| `25-grant-authorization-names-no-grant`                     | `authority.basis`                    |
| `26-grant-authorization-by-another-principal`               | `authority.basis`                    |
| `27-authority-event-on-denied-policy`                       | `authority.basis`                    |
| `28-conditional-basis-without-human-approval`               | `authority.basis`                    |
| `29-task-completed-outside-approved-envelope`               | `authority.task-envelope`            |
| `30-grant-revision-changes-principals`                      | `grant.principal-continuity`         |
| `31-route-session-bound-to-another-route`                   | `route.binding`                      |
| `32-spend-without-prepare-capability-report`                | `route.capability-rejection`         |
| `33-receipt-state-disagrees-with-history`                   | `receipt.subject-reconciliation`     |
| `34-duplicate-run-attempt-number`                           | `lifecycle.run-attempt-uniqueness`   |
| `35-payload-field-representation-mismatch`                  | `structure.mutual-exclusion`         |
| `36-task-branch-thread-without-task`                        | `structure.mutual-exclusion`         |
| `37-route-spec-missing-applicable-basis`                    | `structure.mutual-exclusion`         |
| `38-participant-not-independent-of-every-dimension`         | `structure.collection`               |
| `39-field-secrecy-beyond-its-envelope`                      | `secrecy.inline-secret`              |
| `40-event-artifact-reference-drops-labels`                  | `label.preservation`                 |
| `41-task-completed-without-approved-envelope`               | `authority.task-envelope`            |
| `42-room-revision-wrong-type`                               | `structure.type`                     |
| `43-room-unknown-field`                                     | `structure.unknown-field`            |
| `44-duplicate-identifier`                                   | `identity.uniqueness`                |
| `45-membership-room-wrong-kind`                             | `reference.kind`                     |
| `46-task-skips-required-progression`                        | `lifecycle.progression`              |
| `47-task-revision-out-of-order`                             | `lifecycle.revision-order`           |
| `48-duplicate-event-sequence`                               | `event.causal-order`                 |
| `49-solo-room-not-persistent`                               | `solo-room.defaults`                 |
| `50-external-route-declares-native-extension`               | `route.native-extension-authority`   |
| `51-non-rebuildable-family-recorded-asynchronously`         | `authority.async-source`             |
| `52-incomplete-deferral-inventory`                          | `deferral.inventory`                 |
| `53-run-agent-mismatches-task-assignment`                   | `run.evidence-binding`               |
| `54-egress-grant-acts-on-private-untrusted-content`         | `grant.egress-policy`                |
| `55-competing-writer-after-cutover`                         | `authority.sole-writer`              |
| `56-failed-run-causes-completion-without-operator-decision` | `lifecycle.run-independence`         |
| `57-turn-receipt-conceals-run-through-body`                 | `receipt.subject-reconciliation`     |
| `58-terminal-run-uses-inspection-only-session`              | `route.phase-order`                  |
| `59-narrowed-successor-run-grant`                           | accepted confirming control          |
| `60-run-grant-silently-omits-route-scope`                   | `run.evidence-binding`               |
| `61-route-silently-omits-component-disposition`             | `run.evidence-binding`               |
| `62-task-recovery-evidence-does-not-cite-run`               | `lifecycle.run-independence`         |
| `63-message-author-cannot-speak`                            | `authority.basis`                    |
| `64-stopped-interrupt-lacks-halted-control`                 | `receipt.subject-reconciliation`     |
| `65-duplicate-capability-classification`                    | `run.evidence-binding`               |
| `66-completion-artifact-lacks-immutable-evidence`           | `provenance.preservation`            |
| `67-event-run-omits-owning-task`                            | `run.evidence-binding`               |
| `68-task-branch-event-omits-thread-task`                    | `run.evidence-binding`               |
| `69-run-relies-on-denied-successor-grant`                   | `run.evidence-binding`               |
| `70-machine-authored-task-acceptance`                       | `lifecycle.run-independence`         |
| `71-machine-authored-task-closure`                          | `lifecycle.run-independence`         |
| `72-nonmember-policy-default-author`                        | `authority.basis`                    |
| `73-context-packet-bound-to-another-task`                   | `run.evidence-binding`               |
| `74-unrelated-operator-decision`                            | `lifecycle.run-independence`         |
| `75-run-names-another-runs-session`                         | `route.binding`                      |
| `76-run-receipt-omits-context-packet`                       | `receipt.family-requirements`        |
| `77-run-receipt-omits-route`                                | `receipt.family-requirements`        |
| `78-run-receipt-omits-capability-posture`                   | `receipt.family-requirements`        |
| `79-derived-artifact-self-verifies`                         | `provenance.preservation`            |
| `80-verification-fact-cites-producer-event`                 | `claim-source.separation`            |
| `81-receipt-room-disagrees`                                 | `receipt.subject-reconciliation`     |
| `82-event-grant-room-scope-mismatch`                        | `authority.basis`                    |
| `83-summons-grant-names-another-grantee`                    | `solo-room.loop-prevention`          |
| `84-receipt-participation-hidden-in-cited-event`            | `receipt.subject-reconciliation`     |
| `85-session-spend-without-run-reliance`                     | `route.phase-order`                  |
| `86-commit-sequence-regresses`                              | `event.causal-order`                 |
| `87-receipt-cost-exceeds-task-budget`                       | `receipt.subject-reconciliation`     |
| `88-receipt-tool-outside-grant`                             | `receipt.subject-reconciliation`     |
| `89-receipt-external-effect-outside-grant`                  | `receipt.subject-reconciliation`     |
| `90-machine-operator-direct-lacks-authorizing-event`        | `authority.basis`                    |
| `91-abandoned-run-causes-completion-without-decision`       | `lifecycle.run-independence`         |
| `92-receipt-claim-source-disagrees-with-author`             | `claim-source.separation`            |
| `93-process-provenance-postdates-receipt`                   | `receipt.subject-reconciliation`     |
| `94-duplicate-route-session-owner`                          | `route.binding`                      |

Fixtures are synthetic. They contain no real credential, no provider payload,
and no private material; the inline-secret fixture demonstrates a forbidden
_representation_, using a placeholder value.

## Running the tests

```sh
deno test --allow-read=. \
  contracts/workbench/first-product/v1/validate.test.ts \
  contracts/workbench/first-product/v1/executable-closure.test.ts \
  contracts/workbench/first-product/v1/executable-closure-report.test.ts
```

The report generator uses no network permission. The same lane and deterministic
report generator run inside the repository-owned aggregate gate
(`deno task
test` and `deno task test:fast`) under the existing `test.aggregate`
check id. The lane compares an in-memory regeneration with the checked-in
report using `--compare-path`, with write permission denied. Different bytes
fail the lane without creating an output file. Comparison and `--output-path`
are mutually exclusive; bare invocation still regenerates the tracked report.

## Known limits

- Stable-identity checking follows the **declared** `identity_basis`. The
  validator does not infer ephemerality from the text of an identifier.
- Reference closure is corpus-scoped: a source marked external must carry an
  external authority record, and the validator does not resolve it.
- The route-phase and lifecycle graphs encode only what the accepted contract
  states. Absence of an edge means "not stated here", not "forbidden by
  architecture".
- Authority checking is document-scoped. It decides whether a corpus's own
  records are coherent about who authorized what; it evaluates no policy, runs
  no decision procedure, and grants nothing.
- Secrecy enforcement is tag-presence, not classification. Any secrecy tag at
  all forbids inline bytes; there is no list of "secret-looking" tag names,
  because such a list would carry the bytes of every tag it had not heard of.
- Receipt reconciliation reads the transition history the corpus records. It
  does not reconstruct state from a data layer, and a corpus that records no
  history for a subject is reconciled against no history.
- A Run's relied grant must explicitly scope its Task, Room, route, and any
  named provider. A grant or RouteSpec may omit an inapplicable or unobservable
  component only by recording `not-applicable` or `opaque` for that component;
  the validator never treats silence as a disposition. When a component value is
  present, that observed value is authoritative and an unused disposition marker
  has no effect.
- Sole-writer authority begins at the first `writer_id` a corpus records for an
  event family. Later events in that family must name the same writer; omission
  and competition both reject. Events before that inline cutover remain explicit
  pre-cutover history. The package does not yet model a separate authority
  record for selecting the first writer.
