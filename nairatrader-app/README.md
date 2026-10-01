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

Phase 0 (build system) is in place and green: `pnpm install`, `pnpm lint`, `pnpm typecheck` and
`pnpm test` all pass — 22 tests (18 in `apps/api`, 4 in `packages/shared`), of which 4 run against
a real Postgres 16 container. Toolchain versions are pinned and the reasons are recorded in
`docs/adr/0002-pin-toolchain-prisma6-typescript6.md`.

Already covered by tests: environment validation, the schema/enum drift guard between
`schema.prisma` and `@nt/shared`, and BigInt kobo round-trips, the `UNKNOWN` status, D13b
provenance columns and the one-open-payout rule against a real Postgres.

There is deliberately no seed yet: seeding `ChallengeProductVersion` rows would mean inventing the
conflicting business rules PRD section 6 says the owner must resolve (hard rule 10). It arrives with
the catalog module in Phase 2.

Not yet built, by phase: the gateway seam and shared contracts (1), purchase money path (2),
payouts and resets (3), sync + notifications (4), the Expo client (5), real gateway adapters
and shadow mode (6). `docs/payload-spike.md` and `docs/shadow-mode.md` are the gate records for
Phase 6 and are still empty because the spike needs system access.

`pnpm --filter mobile start` intentionally fails until Phase 5 creates the Expo project, so
versions come from `create-expo-app` rather than guesswork.

## Known schema gaps to resolve before the first production migration

- `PayoutStatus` has no `PENDING_RECONCILE`, which D13c requires for `unknown_outcome`.
- `TradingAccount` persists `asOf`/`stateSource`/`contractVersion` but not `complete` (D13b).
- The Account State Contract carries `profitTargetBps`, `drawdownLimitBps`, `drawdownUsedBps`,
  `drawdownTimezone` with no columns anywhere, so PRD F1 has no storage path yet.
- `Phase` has no `UNKNOWN` member while `AccountStatus` does.
