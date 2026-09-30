# AGENTS.md: how coding agents work in this repo

## Read first
PRD.md (what), Architecture-Essential.md (non-negotiable decisions), RISKS.md (traps). If code conflicts with Architecture-Essential.md, the doc wins; propose an ADR in `docs/adr/` instead of silently diverging.

## Stack and commands
pnpm workspaces: `apps/api` (Fastify), `apps/mobile` (Expo), `packages/shared` (Zod, money, enums).
- Install: `pnpm install`
- Dev API: `pnpm --filter api dev` | Mobile: `pnpm --filter mobile start`
- Test: `pnpm test` | Lint/typecheck: `pnpm lint && pnpm typecheck`
- DB: `pnpm --filter api prisma migrate dev`
Run lint, typecheck and tests before declaring any task done.

## Hard rules
1. Money is BigInt kobo in DB, decimal string in JSON. Use `packages/shared/src/money.ts`. Never use floats for money.
2. Never compute breach/pass in app or API. Status comes from `TradingPlatformGateway`.
3. Every POST that creates orders, payouts or resets requires `Idempotency-Key`.
4. Webhooks: verify signature, dedupe by `(provider, eventId)`, process in one transaction.
5. Call external systems only through `gateways/*` interfaces. Every result is `Result<Sourced<T>, GatewayError>`; never return or consume bare data. Add behavior to the Fake implementation and its contract test together, including fault cases.
5a. On `unknown_outcome`, never retry blindly: hold the entity in `PENDING_RECONCILE` and enqueue a reconcile job (D13c).
5b. Adapters map external values to internal enums; unmapped values become `UNKNOWN`, hold state and alert. Never default (D13e).
5c. Account status and numbers come only from the Account State Contract in `packages/shared/src/schemas/account-state.ts`. Reject unknown `contractVersion`.
6. Payout state changes go through `payouts/state.ts` transition table only.
7. No secrets, real credentials or PII in code, logs, tests or fixtures. Use `.env.example` names only.
8. Validate all input with Zod schemas from `packages/shared`. No `any`.
9. Do not add dependencies without stating why in the PR description.
10. Do not invent business rules. If a rule is not in a `ChallengeProductVersion` row or the PRD, ask.

## Working style
- Small PRs, one module each. Tests with the change. Add a migration for every schema edit; never edit an applied migration.
- Prefer boring code. If you are adding an abstraction with one implementation and no gateway need, don't.
- Mark anything uncertain with `// VERIFY:` and list it in the PR.
- When blocked by an unknown (MT5 access, processor details), implement against the Fake gateway and stop; do not guess a real API.

## Definition of done
Typechecks, lints, tests pass, error paths covered, idempotency tested for money endpoints, no new `VERIFY` left unlisted.
