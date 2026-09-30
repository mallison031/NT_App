# PRD: NairaTrader Companion App (v1)

> **Provenance warning.** Written WITHOUT a crawl of nairatrader.ng (site is JS-rendered; fetch returned only a title). Sections were inferred from search results, the blog, and reviews. Every `[VERIFY]` item must be checked by the owner against the live site before build. Do not treat inferred rules as truth.

## 1. Problem
Traders manage a NairaTrader challenge across a website, MT5, Telegram, and support tickets. Pain points visible in public reviews: unclear account state after a breach, payout status uncertainty, and price confusion at purchase. [Likely]

## 2. Goals (v1)
1. A trader can see every account's phase, balance, equity, profit target progress, drawdown headroom, and days left, and trust the numbers match the breach engine.
2. A trader can request a payout and track it end to end.
3. A trader can buy a challenge at a price locked at quote time.
4. A trader can request reset / refund / support and see status.
5. Push notifications for phase pass, breach warning, breach, payout status.

## 3. Non-goals (v1)
- Trading inside the app (MT5 stays the terminal).
- Computing breach decisions (the existing risk engine stays the only authority).
- Moving money automatically (payouts stay approved and paid by ops; the app requests and tracks).
- Admin dashboard (existing tooling), web rewrite, copy-trading, social features.

## 4. Users
| Persona | Needs |
|---|---|
| Trader (primary) | Account state, purchase, payout, reset, support |
| Affiliate | Referral link, referred sales, commission status |
| Support/Ops (indirect) | Structured tickets and payout requests arrive clean |

## 5. Site sectors mapped to app scope  [VERIFY each]
| Site sector (inferred) | App v1 | Notes |
|---|---|---|
| Home / trust stats (payout total, trader count) | Read-only cached banner | Numbers must come from one source, not hardcoded |
| Account catalog / pricing | Yes | Sizes seen: 500K to 10M; scaling to 100M [VERIFY] |
| How it works / rules | Yes (rules screen per account) | Rules shown are the rules snapshotted on THAT account |
| Purchase / checkout | Yes | Paystack/Flutterwave [VERIFY current processor] |
| Trader dashboard | Yes (core) | |
| Payout request | Yes | "Within 24hrs" claim [VERIFY SLA] |
| Breach reset / fee refund | Yes (request + status) | Eligibility rules [VERIFY] |
| Scaling plan | Yes (progress display) | |
| Affiliate program | v1.1 | |
| Blog / education | Link out (webview) | Not rebuilt |
| Reviews subdomain | Link out | |
| Support / Telegram | Ticket form + Telegram deep link | |

## 6. Business rules seen in public sources  (CONFLICTING; owner must fix a single source of truth)
- Drawdown: 20% (older), 30% (X bio, "2.0"), 5% eval DD in 2.0 phases. Phases: 2 vs 3.
- Entry price examples: ₦4,000 / ₦8,000 / ₦8,900 / ₦9,500. Profit share seen: 70% and 100%.
- 60-day phase deadline, automatic breach on miss (2.0 blog).
- "No KYC" claimed (2.0 blog). Payout to bank implies some identity handling. [VERIFY legal position]
Resolution: rules live in `ChallengeProductVersion` rows, not code. The app renders what the row says.

## 7. Functional requirements (with acceptance criteria)
**F1 Account dashboard.** List accounts; detail shows phase, balance, equity, target %, drawdown used/limit, deadline, status, last-synced timestamp.
 - AC: if data is older than 5 min, UI shows "stale" with timestamp; never shows a fresh-looking number without it.
 - AC: breach state comes only from `TradingAccount.status`; app never derives it.
**F2 Purchase.** Pick size, get a `PriceQuote` (valid 15 min), pay, account provisioned, credentials delivered in-app.
 - AC: charged amount equals quoted amount even if catalog price changes.
 - AC: duplicate webhook does not create a second account.
**F3 Payout.** Request amount ≤ available profit share; choose saved bank account; track states REQUESTED → UNDER_REVIEW → APPROVED → PAID (or REJECTED/FAILED).
 - AC: a second request while one is open for the same account is blocked with reason.
**F4 Reset / refund.** Request, eligibility shown before submit, status tracked.
**F5 Notifications.** Push + in-app inbox: phase passed, 80% drawdown warning [VERIFY threshold], breach, payout status, deadline in 7/3/1 days.
**F6 Support.** Create ticket with account attached; message thread; Telegram link.
**F7 Auth.** Uses existing identity via adapter; device registration for push.

## 8. Non-functional
- Low-end Android first; cold start < 3s on mid-range device [target, unmeasured]. Cached read-only when offline.
- Money: NGN only, integer kobo. No floats anywhere.
- All money-moving and status-changing actions are idempotent and audit-logged.
- Payload discipline: dashboard endpoint < 30 KB gzipped.

## 9. Metrics (proposed targets; baselines unknown)
Weekly active traders / total active; support tickets per 100 accounts (down); payout "where is my money" tickets (down); checkout completion rate.

## 10. Open questions the owner must answer
1. What is the MT5 integration today (Manager API, MetaApi, broker bridge)? 2. Where does account/risk state live today? 3. Who processes payments and payouts? 4. Is there legal advice on prop-firm status in Nigeria (SEC, CBN)? 5. Is 100% "registration fee refund" a liability tracked anywhere?
