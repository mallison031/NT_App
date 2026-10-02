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
    pnpm --filter api prisma db push   # dev database straight from the schema (no migration exists yet)
    pnpm db:seed              # two placeholder offers, so the purchase path can be walked
    pnpm --filter api dev     # API on 127.0.0.1:3000 (override HOST/PORT in .env)
    pnpm lint
    pnpm typecheck
    pnpm test                 # unit + contract; integration needs Docker
    pnpm --filter api prisma migrate dev

Copy `.env.example` to `apps/api/.env`. Only `DATABASE_URL` is required to boot.

## Where the project stands

Phase 0 (build system), Phase 1 (gateway seam + shared contracts) and Phase 2 (the purchase money
path) are in place and green: `pnpm install`, `pnpm lint`, `pnpm typecheck` and `pnpm test` all pass
— 207 tests (129 in `apps/api`, 78 in `packages/shared`), of which 30 run against a real Postgres 16
container.
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

Phase 2 put the money path behind that seam (F2, D4, D5, D13c, D13f):

- `packages/shared/src/schemas/purchase.ts` — both halves of the purchase wire: what a client may
  send (`strictObject`, so a body cannot propose a price) and what comes back (kobo as decimal
  strings, instants as UTC ISO), plus the error codes a client may branch on.
- `apps/api/src/modules/catalog` and `modules/quotes` — the catalog renders the effective version
  row and nothing else (D3); a quote copies its price and holds it for fifteen minutes (D4).
- `apps/api/src/modules/orders` — the order state table (D7), order creation with its three layers
  of idempotency (D5) — including the refusal to write a charge answer whose `(provider,
  providerRef)` a different order already owns — and fulfilment, which treats provisioning as a
  ticket rather than a response (D13d) and never writes an account status (D1).
- `apps/api/src/modules/payments/webhook.ts` — verify the bytes, dedupe on `(provider, eventId)`,
  then read the charge back and believe *that* rather than the notification (hard rule 4, D13f), all
  under one `FOR UPDATE` lock.
- `apps/api/src/jobs/reconcile-pending.ts` — one pass over held orders (D13c): it re-asks questions
  and never re-issues writes.
- `apps/api/src/http/` — the composition root, the raw-bytes JSON parser that makes signature
  verification possible, the error handler that keeps gateway details out of responses, and three
  dev-only routes that stand in for the pieces a developer does not have.

### Walking the purchase path by hand

With Postgres up, the schema pushed and the seed run (commands above), this is the whole of F2:

    BASE=http://127.0.0.1:3000
    curl -s $BASE/healthz
    TOKEN=$(curl -s -X POST $BASE/v1/dev/session -H 'content-type: application/json' \
      -d '{"externalId":"dev-trader-1"}' | jq -r .token)
    curl -s $BASE/v1/catalog | jq -c '.offers[] | {productSlug, priceKobo, accountSizeKobo}'
    QUOTE=$(curl -s -X POST $BASE/v1/quotes -H "authorization: Bearer $TOKEN" \
      -H 'content-type: application/json' -d "{\"productVersionId\":\"$(curl -s $BASE/v1/catalog | jq -r '.offers[0].productVersionId')\"}")
    ORDER=$(curl -s -X POST $BASE/v1/orders -H "authorization: Bearer $TOKEN" \
      -H 'content-type: application/json' -H 'idempotency-key: walkthrough-1' \
      -d "{\"quoteId\":\"$(echo $QUOTE | jq -r .id)\"}")
    curl -s -X POST $BASE/v1/dev/payments/deliver -H 'content-type: application/json' \
      -d "{\"providerRef\":\"$(echo $ORDER | jq -r .payment.providerRef)\"}"   # -> {"effect":"paid"}
    curl -s $BASE/v1/orders/$(echo $ORDER | jq -r .id) -H "authorization: Bearer $TOKEN" | jq -c .status
    curl -s -X POST $BASE/v1/dev/reconcile -H 'content-type: application/json' -d '{}' | jq -c .results
    curl -s $BASE/v1/orders/$(echo $ORDER | jq -r .id) -H "authorization: Bearer $TOKEN" | jq -c .account

The order goes `PENDING_PAYMENT` → `FULFILLING` (the charge is confirmed by reading it back, not by
believing the delivery) → `FULFILLED` with a login, and the reconcile pass reports why each order it
touched ended where it did. Repeating the `POST /v1/orders` with the same `Idempotency-Key` returns
the same order and does not create a second charge — that is the D5 property, and
`test/integration/purchase.test.ts` asserts it over the wire.

Walking it a second time means a new `Idempotency-Key` value, because the first pass's key is stored
for twenty-four hours and a replay is supposed to return the first order, not a new one. The fakes
issue charge references, webhook event ids and MT5 logins that differ per process for the same
reason: the dev database outlives the API process, and a fake that restarted its counters at 1 would
have every later delivery read as a duplicate of one already closed. `test/unit/fake-identifiers.test.ts`
holds that.

The three `/v1/dev/*` routes exist because the processor's webhook is signed with a key this process
does not have and the D12 worker container is not built yet. They register only when the identity and
payments gateways are the Fakes *and* `NODE_ENV` is not production, so no deployment of this app can
answer one (see `src/http/app.ts`).

Already covered by tests: environment validation, the schema/enum drift guard between
`schema.prisma` and `@nt/shared`, kobo parsing and formatting, the contract version gate and its
required-field refusals, unmapped-value handling, ticket/idempotency write discipline, webhook
signature rejection, the order state table's edges, the fifteen-minute quote deadline, and — against
a real Postgres over HTTP — the trader journey from catalog to a provisioned login, a replayed
`Idempotency-Key`, a hash clash, an expired quote, a tampered webhook body, a duplicate and an
out-of-order delivery, a charge held for the wrong amount, a processor answer that names a reference
another order already owns, and an `unknown_outcome` that parks the
order in `PENDING_RECONCILE` until the reconcile pass closes it.

There is one seed and it is dev-only: `apps/api/prisma/seed-dev.ts` writes two labelled placeholder
offers so the path above can be walked. It is not a catalog. The real prices, account sizes, targets
and drawdown limits stay the owner's to set (hard rule 10, PRD section 6), which is why nothing in the
app reads those numbers as a rule and why they head the owner-blocked list below.

Not yet built, by phase: payouts and resets (3), sync + notifications (4), the Expo client (5),
real gateway adapters and shadow mode (6). `docs/payload-spike.md` and `docs/shadow-mode.md` are the
gate records for Phase 6 and are still empty because the spike needs system access.

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

## Phase 2 left these for the owner

Nothing above needed a decision to be made, but these did, and each one was answered with the
smallest honest behaviour rather than a guess. They are the list to settle before Phase 3:

- **Real catalog rows.** The seed's two placeholder offers are not products. Prices, account sizes,
  profit targets, drawdown limits and deadlines are all `ChallengeProductVersion` data (D3), and
  PRD section 6 says public sources disagree about them.
- **Which processor.** `PAYMENTS_PROVIDER` defaults to `fake`; `apps/api/src/config/env.ts:16` carries
  the open question, and the fake's webhook body (`gateways/fakes/fake-payments.ts:57`) is a shape the
  real processor will replace.
- **A quote that outlives a withdrawal.** `modules/quotes/service.ts:84` — PRD does not say whether an
  already-quoted product may still be bought after it is withdrawn. Today the order path re-checks
  saleability, so it may not.
- **Whether a catalog edit makes a new row.** `modules/quotes/service.ts:128` — the price-drift guard
  assumes it does. If a row can be edited in place, quoting and buying disagree about the amount and
  this build refuses the purchase rather than picking a number.
- **A paid order that cannot be provisioned** holds in `PENDING_RECONCILE` forever
  (`modules/orders/fulfilment.ts:127-131`). Refunds are not built and PRD section 3 leaves the money
  with ops, so what ops should *see* in that state is an owner decision, not an engineering one.
- **An account row exists from the moment an order is opened** (`modules/orders/create.ts:101-133`),
  because D3 freezes the rules at purchase and needs somewhere to freeze them into. That means an
  unpaid or failed purchase also leaves a `PENDING_PROVISION` account row. If that reads wrong on the
  dashboard, the fix is a status or a filter, and it is the owner's call.
- **A quote deadline gates the order, not the payment.** Once an order is open its amount is the
  quote's for as long as the charge takes (D4). Fifteen minutes is the quote's window, not a payment
  window.

*Also worth knowing:* the dev seed is wired through `package.json#prisma`, which Prisma 6 accepts and
Prisma 7 replaces with a config file. It prints a deprecation warning today and moves in the Phase 6
dependency pass.
