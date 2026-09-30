# What will break / edge cases / over-engineering
Confidence tags: [Certain] [Likely] [Guessing]

## What will break
1. **Gateway integration is the schedule risk.** Nobody has told us how MT5 data is exposed. If it is a screen-scraped or DB-poll setup, sync will be slow and flaky. [Likely]
2. **Webhook races.** Processor retries + user hitting "I paid" produce double fulfillment unless D5 is enforced. [Certain]
3. **Drawdown display mismatch.** Users compare app numbers to MT5 and to the breach email; equity timing differences cause "you breached me wrongly" tickets. [Likely]
4. **Push delivery on Nigerian Android.** Aggressive OEM battery killers drop pushes; users will miss breach warnings. Need in-app inbox as the source of truth. [Likely]
5. **Load spikes on promo days** ("Monday blessing" payouts, limited offers): purchase + sync + dashboard at once. Sync jobs must not starve purchase paths (separate queues). [Likely]
6. **Payout status trust.** A tracker that says APPROVED while the bank says nothing becomes the new complaint. Requires ops discipline, not code. [Likely]
7. **Impersonation.** Clone sites (.is, ai sites) will clone the app's look; store listing and deep links must be verified (App Links). [Likely]

## Edge cases we are missing
- Breach at the same second as a payout request; payout requested on an account that becomes BREACHED before APPROVED.
- Trader passes phase but never upgrades; deadline (60 days) hits while upgrade is pending.
- Profit above a cap is "removed but not a violation" (forum claim): displayed profit vs withdrawable profit differ. [Guessing, VERIFY]
- Price changed between quote and payment; partial payments; over-payments; bank transfer arriving after quote expiry.
- Refund after 4th payout ("100% refund after fourth payout"): counting payouts across multiple accounts vs per account. [VERIFY]
- Same person, multiple accounts, one bank name mismatch on payout (name on bank ≠ profile).
- Time zones: daily drawdown resets at which timezone/server time? Display must match the engine. [VERIFY]
- Weekend/holiday sync gaps; MT5 server maintenance; account deleted in MT5 but present locally.
- Minors and identity: "No KYC" vs bank payouts and Nigerian regulation. Legal question, not engineering. [Guessing on exposure]
- Currency: naira accounts marketed against dollar-size comparisons; inflation is a user complaint, not something the app fixes.
- User changes phone/email; device change; refresh token theft.
- Support ticket attached to an account that later resets.

## What's over-engineered (audit of my own design)
- **Circuit breaker + outbox + reconcile job in v1:** the first two are worth it; the nightly reconcile can be a manual script until money volume proves the need. Cut candidate. [Likely]
- **Affiliate module:** already deferred to v1.1; keep it out of the schema migration until built (schema includes tables; comment if you want it leaner).
- **Rotating refresh tokens:** simple long-lived session with server-side revocation is enough if identity is already handled upstream. [Guessing]
- **Separate worker container:** run workers in the API process until load says otherwise.
- **AuditLog on every read:** no; writes only.
- **Kept on purpose (not over-engineered):** quotes, rule snapshots, idempotency, gateway interfaces, kobo integers. Each maps to a documented complaint or an unrecoverable class of bug.
