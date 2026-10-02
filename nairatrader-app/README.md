# NairaTrader Companion App

Companion app for an existing prop-firm: traders see account state, buy a challenge at a
quoted price, request and track payouts/resets, and get notified. It is a read-mostly BFF
plus mobile client — the existing risk engine, payment stack and MT5 layer stay authoritative.

Read `PRD.md` (what), `Architecture-Essential.md` (D1–D13, non-negotiable), `RISKS.md`
(traps) before changing anything. `AGENTS.md` holds the hard rules for coding agents.

## Layout

    apps/api         Fastify BFF + worker entrypoints, Prisma schema, tests
    apps/mobile      Expo client — scaffolded in Phase 5, not yet present
    packages/shared  Zod schemas, money helpers, enums (no deps on apps)
    docs/adr         architecture decision records
    docs/            openapi contract, payload-spike log, shadow-mode report

## Prerequisites

- Node >= 24, pnpm 11 (`corepack enable`)
- Docker for the Postgres integration tests, via Colima on macOS:
  `brew install colima docker docker-compose && colima start --vm-type=vz --cpu 2 --memory 4 --disk 20`
  Then `docker pull postgres:16-alpine` once (the first `pnpm test` would otherwise pull it mid-run).
- `test/helpers/postgres.ts` points testcontainers at Colima's socket and disables its reaper
  container: Colima cannot bind-mount a socket from the macOS filesystem, and the reaper failing
  takes every DB test with it. Containers are stopped by the suite itself instead.
- Without a daemon the integration suite skips with a visible warning; under `CI=1` it fails
  instead, so a build without Docker cannot pass quietly.

## Commands

    pnpm install
    pnpm db:generate          # prisma client
    pnpm --filter api dev     # API on 127.0.0.1:3000 (override HOST/PORT in .env)
    pnpm lint
    pnpm typecheck
    pnpm test                 # unit + contract; integration needs Docker
    pnpm --filter api prisma migrate dev

Copy `.env.example` to `apps/api/.env`. Only `DATABASE_URL` is required to boot.

## Where the project stands

Phase 0 (build system) and Phase 1 (gateway seam + shared contracts) are in place and green:
`pnpm install`, `pnpm lint`, `pnpm typecheck` and `pnpm test` all pass — 133 tests (84 in
`apps/api`, 49 in `packages/shared`), of which 6 run against a real Postgres 16 container.
Toolchain versions are pinned and the reasons are recorded in
`docs/adr/0002-pin-toolchain-prisma6-typescript6.md`.

Phase 1 built the seam between the BFF and the three systems it does not own (D6, D13):

- `packages/shared/src/money.ts` — the only kobo ↔ decimal-string converter, plus basis-point
  arithmetic (D2, hard rule 1).
- `packages/shared/src/schemas/account-state.ts` — the Account State Contract with its version
  gate, required fields, staleness rule and `complete` guard (D13a, D13b).
- `apps/api/src/gateways/types.ts` — the three gateway interfaces, `Sourced<T>` provenance and the
  four typed failure kinds (D13b, D13c).
- `apps/api/src/gateways/normalize.ts` — a value outside an adapter's mapping table becomes
  `UNKNOWN` and is reported, never guessed (D13e).
- `apps/api/src/gateways/fault-profile.ts` and `fakes/` — three hostile fakes with seeded,
  basis-point-rate fault injection (D13g).
- `apps/api/test/contract/gateway-contract.ts` — one suite that any gateway implementation must
  pass. It runs against the fakes today; the Phase 6 adapters reuse it unchanged.

Already covered by tests: environment validation, the schema/enum drift guard between
`schema.prisma` and `@nt/shared`, kobo parsing and formatting, the contract version gate and its
required-field refusals, unmapped-value handling, ticket/idempotency write discipline, webhook
signature rejection, and — against a real Postgres — BigInt kobo round-trips, the `UNKNOWN`
account/phase/payment statuses, the D13b provenance and rule columns, `PENDING_RECONCILE` and
payout idempotency-key uniqueness.

There is deliberately no seed yet: seeding `ChallengeProductVersion` rows would mean inventing the
conflicting business rules PRD section 6 says the owner must resolve (hard rule 10). It arrives with
the catalog module in Phase 2.

Not yet built, by phase: purchase money path (2), payouts and resets (3), sync + notifications (4),
the Expo client (5), real gateway adapters and shadow mode (6). `docs/payload-spike.md` and
`docs/shadow-mode.md` are the gate records for Phase 6 and are still empty because the spike needs
system access.

`pnpm --filter mobile start` intentionally fails until Phase 5 creates the Expo project, so
versions come from `create-expo-app` rather than guesswork.

## Schema: closed in Phase 1, and still the owner's to decide

The four gaps listed here previously are closed: `Phase`, `BreachReason` and `PaymentStatus` each
gained `UNKNOWN` (D13e), `PayoutStatus` gained `PENDING_RECONCILE` (D13c), and `TradingAccount` now
stores `stateComplete` plus the contract's rule numbers (`profitTargetBps`, `drawdownLimitBps`,
`drawdownUsedBps`, `drawdownTimezone`), so PRD F1 has a storage path. The drift guard keeps
`schema.prisma` and `@nt/shared` in lockstep. No migration has been applied yet — the schema is
still edited directly and pushed by the test suite, so the first real migration has to carry all of
this.

What the schema now stores without deciding (each one needs the owner, hard rule 10):

- `withdrawableKobo` — whose number is it: the engine's, the gateway's, or a BFF calculation?
- `drawdownTimezone` — stored and displayed; nothing resets daily drawdown using it yet.
- Purchased rule values live in `AccountRuleSnapshot` (frozen at purchase) while the contract
  reports current ones on `TradingAccount`. The two disagreeing is shadow-mode drift to alert on,
  not something this build reconciles.
