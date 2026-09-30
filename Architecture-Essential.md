# Architecture-Essential: critical decisions only, each fully specified

Scope note: "only critical decisions" and "most complete" conflict. Interpretation: fewer decisions, each specified to implementation level.

## D1. The risk engine is the only authority on account state
- App never sets or infers BREACHED/PASSED. `TradingAccount.status` changes only via `TradingPlatformGateway.getStatus()`.
- App may display "headroom = limit - used" labelled "estimated"; breach copy uses server status only.
- Why: prop-firm disputes are about rule interpretation; two calculators guarantee disagreement.

## D2. Money is integer kobo, NGN only
- DB: `BigInt`. JSON: decimal string. Shared helper `packages/shared/src/money.ts` is the only formatter/parser. Lint rule bans `parseFloat`/`Number()` on money fields.
- Percentages stored as basis points (`3000` = 30%).

## D3. Rules are data, versioned, and snapshotted per account
- `ChallengeProductVersion` holds phases, targets, drawdown, deadline days, profit share bps, price, effective_from.
- On purchase, copy into `AccountRuleSnapshot`. Later catalog edits never change existing accounts.
- Why: public sources show conflicting drawdown/phases/prices; this stops silent rule drift.

## D4. Price is locked by quote
- `PriceQuote{id, productVersionId, amountKobo, expiresAt(+15min), userId}`. Order must reference an unexpired quote. Payment amount must equal quote amount or the webhook is rejected and flagged.
- Why: reviews cite large price swings between visits.

## D5. Every mutating money/status endpoint is idempotent
- `Idempotency-Key` stored with request hash + response for 24h. Webhooks deduplicated by `(provider, eventId)` unique index. Fulfillment inside one DB transaction with `SELECT ... FOR UPDATE` on the order.

## D6. Gateways isolate the unknowns, but return provenance and typed failures (see D13)
- Interfaces: `TradingPlatformGateway {getAccountState, requestProvision, getProvision, requestReset, getReset, listTrades}`, `IdentityGateway {verifyToken, getUser}`, `PaymentsGateway {initCharge, getCharge, verifyWebhook}`.
- All results use `Result<Sourced<T>, GatewayError>` from `apps/api/src/gateways/types.ts`. No gateway returns bare data.
- Ship with `Fake*` implementations first, with fault injection (D13). Real adapters slot in later without changing modules.
- Once the payment processor is known, narrow `PaymentsGateway` to that provider's real shape; do not maintain a multi-provider abstraction.

## D7. Payouts are request-and-track only in v1
- States: REQUESTED → UNDER_REVIEW → APPROVED → PAID | REJECTED | FAILED. Transitions validated by a table in `payouts/state.ts`; illegal transitions throw.
- One open payout per account. Amount ≤ gateway-reported withdrawable at request time, re-checked at APPROVED.
- The app never triggers a bank transfer in v1.

## D8. Sync model: pull with staleness disclosure
- BullMQ repeatable jobs: 60s (evaluation), 5m (funded), backoff on gateway failure, circuit breaker after 5 failures/2 min.
- Every account response includes `lastSyncedAt`; client shows stale badge at >5 min.

## D9. Auth: delegate identity, own the session
- Verify against existing identity through adapter; issue 15-min access JWT + 30-day rotating refresh token (hashed at rest). Device row per push token. Revoke on password reset event.

## D10. Notifications are outbox-driven
- Domain events write to `Notification` + outbox in the same transaction; a worker sends push. Push failure never fails the business transaction.

## D11. Secrets and credentials
- MT5 passwords: encrypted AES-256-GCM, key from KMS, shown once at provisioning then only re-issuable via reset. Never logged. Bank account numbers stored encrypted, returned masked.

## D12. Deployment shape
- One API container + one worker container (same image, different command) + Postgres + Redis. Single region near Lagos, daily backups with tested restore, staging environment with Fake gateways.

## D13. Own the seam: Account State Contract, provenance, typed failures, hostile fake
Problem: gateway interfaces leak when unknowns differ in freshness, timing semantics, async behavior and failure modes. A uniform-looking interface cannot hide that.

**13a. Account State Contract (versioned).** The BFF depends on a JSON contract published by NairaTrader's own risk engine or a thin exporter service, not on raw MT5. Delivered by signed push events or a single polled endpoint. Fields, all required:
`contractVersion, login, status, phase, balanceKobo, equityKobo, withdrawableKobo, profitTargetBps, drawdownLimitBps, drawdownUsedBps, drawdownTimezone, phaseDeadline|null, asOf (UTC ISO), source`.
Owner must define `withdrawable` and `drawdownTimezone` explicitly. Zod schema: `packages/shared/src/schemas/account-state.ts`. Unknown `contractVersion` is rejected and alerts.
Fallback (temporary only): read-replica adapter behind the same contract. Rejected as primary: direct MT5 Manager API in the BFF; third-party bridge (unverified fit).

**13b. Provenance on every gateway result.** `Sourced<T> = {data, asOf, source, complete}`. The UI staleness badge (D8) uses `asOf`, not our write time. `complete:false` data is never used for status transitions.

**13c. Typed failures.** `GatewayError = transient | permanent | unsupported | unknown_outcome`.
- transient: retry with backoff (circuit breaker per D8).
- permanent: fail the operation, alert.
- unsupported: capability missing, surface as feature-off, never as an error to the user.
- unknown_outcome: the operation may have succeeded. Never retry blindly; enqueue a reconcile job that queries the gateway using the operation's idempotency key or ticket, and hold the entity in a `PENDING_RECONCILE` state.

**13d. Slow operations are tickets.** `requestProvision` and `requestReset` return a `Ticket{id}`; completion is observed by polling `get*` or by event. Orders stay FULFILLING until the ticket resolves.

**13e. Normalize at the boundary.** Adapters convert to kobo, UTC, basis points, internal enums. Any unmapped external value becomes `UNKNOWN`: the entity's state is held, a metric `gateway_unknown_mapping_total` increments, and an alert fires. Never default to a guess.

**13f. Payments confirm, not trust.** A webhook only triggers a `getCharge` confirmation call; fulfillment requires confirmed status AND amount equal to the quote (D4). Mismatch sets `AMOUNT_MISMATCH`.

**13g. Hostile Fake.** `Fake*` gateways accept a fault profile: latency, stale `asOf`, duplicate events, out-of-order events, timeout-after-success, `UNKNOWN` enum values, incomplete payloads. One shared contract test suite (`apps/api/test/contract`) runs against the fake and, when available, the real adapter. A PR that changes a gateway must update both.

**13h. Rollout gates.**
1. Spike (1 to 2 days): capture real MT5-layer and processor-sandbox payloads, freeze the contract. Investigate TradingPlatform first; build it last (order: Payments, Identity, TradingPlatform).
2. Shadow mode: run sync with values hidden from users; diff against MT5 and back office. Launch only when drift is within the agreed tolerance (proposed: 2 weeks, tolerance set by owner).
3. Production monitors: `asOf` skew, `UNKNOWN` mapping count, contract-version mismatches, `PENDING_RECONCILE` age.

Limit: no abstraction hides rule semantics. Drawdown timezone and withdrawable definition are owner-supplied contract fields.

## Explicit non-decisions (defer)
Web app, microservices, GraphQL, event sourcing, feature-flag platform, custom analytics pipeline.
