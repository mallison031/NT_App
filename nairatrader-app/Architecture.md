# Architecture (full)

## 1. Context
Companion app for an existing prop firm. The website, MT5 layer, risk engine and payment stack already exist and remain authoritative. The new system is a **read-mostly BFF plus mobile client**. Unknown internals are hidden behind gateway interfaces so the app is buildable before integration answers arrive.

```
Expo app ──HTTPS/JSON──> API (Fastify, BFF) ──> Postgres (app DB)
                              │  └──> Redis/BullMQ (sync, notify, reconcile)
                              ├──> TradingPlatformGateway  (MT5 / risk engine)   [adapter]
                              ├──> IdentityGateway         (existing user store) [adapter]
                              ├──> PaymentsGateway         (Paystack/Flutterwave)[adapter]
                              └──> Expo Push / FCM
```

## 2. Tech stack
| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere | One language, shared Zod schemas |
| Mobile | Expo (React Native), Expo Router, TanStack Query | One codebase Android/iOS, OTA updates fix bugs without store delay |
| API | Fastify + Zod | Fast, small, typed validation |
| DB | PostgreSQL 16 + Prisma | Relational money data, migrations |
| Queue/cache | Redis + BullMQ | Sync jobs, retries, rate limits |
| Auth | Adapter to existing identity; app issues short JWT + rotating refresh | Avoids second user store |
| Push | Expo push service (FCM under the hood) | Least setup |
| Hosting | Single region container host near Lagos users (e.g., AWS af-south-1) [Likely available] | Latency to Nigerian users |
| Observability | Pino logs, Sentry, basic Prometheus metrics | Enough |
| Package mgr | pnpm workspaces (no Turborepo yet) | Turbo is unneeded at 3 packages |

## 3. Modules (apps/api/src/modules)
auth, accounts, catalog, orders, payments, payouts, resets, support, notifications, affiliates (v1.1), webhooks. Each: `routes.ts`, `service.ts`, `repo.ts`, `schemas.ts`. Services never call another module's repo directly, only its service.

## 4. Key flows
**Sync.** Job per active account every 60s (evaluation) / 5 min (funded) calls `TradingPlatformGateway.getSnapshot(login)`, writes `EquitySnapshot`, updates `TradingAccount` cache fields + `lastSyncedAt`. Status transitions come only from `getStatus()` (risk engine), never computed locally.
**Purchase.** POST /quotes → `PriceQuote` (15 min TTL) → POST /orders (quoteId, idempotency key) → PaymentsGateway init → user pays → webhook (signature verified, stored in `WebhookEvent` unique by provider+eventId) → `OrderService.fulfill()` in one DB transaction → provision job → account row + credentials → push.
**Payout.** POST /payouts (idempotency key) validates open-request rule and available amount from gateway at request time → row REQUESTED → ops action (existing tools or later admin endpoint) moves state → notification.
**Reconcile.** Nightly job compares local orders/payments to processor and account ledger to gateway; drift opens an internal alert.

## 5. Data model
Authoritative in `apps/api/prisma/schema.prisma`. Summary: User, Device, ChallengeProduct, ChallengeProductVersion, PriceQuote, Order, Payment, WebhookEvent, TradingAccount, AccountRuleSnapshot, EquitySnapshot, BreachEvent, ResetRequest, PayoutMethod, PayoutRequest, RefundRecord, SupportTicket, TicketMessage, Notification, AffiliateProfile, Referral, AuditLog.

## 6. API conventions
REST JSON, `/v1`, cursor pagination, `Idempotency-Key` header required on POST that creates orders/payouts/resets, error shape `{code, message, details}`, money as string kobo (`"150000000"`) in JSON to avoid JS precision loss.

## 7. Security
Adapter secrets in env/secret manager; MT5 credentials shown once, stored encrypted (AES-GCM, key from KMS); webhook HMAC verified; rate limit per user+IP; bank details masked in responses; AuditLog on every state change; no PII in logs.

## 8. Testing
Unit: rules/formatting/money. Integration: API + Postgres via testcontainers. Contract tests for each gateway using recorded fixtures. Webhook replay tests. One E2E per money flow.

## 9. Alternatives considered and rejected
- Native Kotlin/Swift: two codebases, no gain for a dashboard app.
- Microservices: team size and traffic do not justify it.
- Recompute drawdown in app: creates disputes when app and risk engine disagree.
- Rebuild site as web app: out of scope; existing site works.
