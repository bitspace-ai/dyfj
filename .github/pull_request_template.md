# Merge checklist (enforced by the human merging — not automated in CI)

- [ ] `full-gate` CI green
- [ ] Publish-gate review run once (single pass) at PR time; report path recorded below
- [ ] Docs-only changes after the review did not trigger a re-review (reissued receipt attached if the SHA changed)
- [ ] Live-smoke output pasted in the PR or linked receipt

Publish-gate report path:

`operator/reviews/<BIT-###>/publish-gate/<provider>-<YYYY-MM-DD>.md`

Receipt: local `.dyfj/security-receipts/publish-gate-<sha12>.json` in the
reviewer's checkout (gitignored; do not commit it). Merge only when the PR
head equals the receipt's gated head, keep the squash subject/body to the
clean PR title, and never merge while a needs-fix receipt is unadjudicated.
