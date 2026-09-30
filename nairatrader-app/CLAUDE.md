@AGENTS.md

# Claude-specific
- Plan before editing anything under `apps/api/src/modules/{orders,payments,payouts}`: state the transaction boundary and idempotency approach first.
- When asked to "add a rule" or "change pricing", edit data/seed for `ChallengeProductVersion`, not code branches.
- Before large refactors, re-read Architecture-Essential.md decisions D1 to D12 and name which ones the change touches.
- Prefer running the test suite over asserting a change works. Report what you ran and the result.
- If a task needs facts about the live NairaTrader site or MT5 setup that are not in the docs, ask the owner rather than assuming.
- Any task touching `gateways/` or sync: name which of D6 and D13a to D13h it affects, and confirm the shared contract test suite runs against the Fake with fault profiles.
