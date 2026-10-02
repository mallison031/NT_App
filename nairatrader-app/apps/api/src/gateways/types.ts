// D6 + D13: the seam between this BFF and the three systems it does not own. Modules talk
// to gateways through these interfaces only, and every result carries provenance (asOf,
// source, complete) and one of four typed failure kinds. Real adapters slot in at Phase 6
// without changing a caller.
//
// The request/response shapes below are what *this* app needs, deliberately not guesses at
// MT5 or processor wire formats — those are captured in docs/payload-spike.md and mapped by
// the adapter, per D13e. Anything that could plausibly differ from the real payload carries
// a VERIFY marker so the spike can settle it.

import type { AccountState, BreachReason, Kobo, PaymentStatus } from '@nt/shared';

/** D13b: provenance on every gateway result. */
export type Sourced<T> = { data: T; asOf: Date; source: string; complete: boolean };

/** D13c: the four typed failure kinds. */
export type GatewayError = 'transient' | 'permanent' | 'unsupported' | 'unknown_outcome';

export type Result<T, E> =
  | { ok: true; value: T }
  // `detail` is for operators and is never shown to a trader as-is. `ref` carries the handle
  // needed to resolve an unknown_outcome: the ticket id or the operation's idempotency key
  // (D13c reconcile), so the retry path queries instead of repeating the write.
  | { ok: false; error: E; detail?: string; ref?: string };

/** D13d: slow operations are tickets, not synchronous results. */
export type Ticket = { id: string };

/**
 * State of an async platform operation as observed through its ticket. Internal vocabulary:
 * the adapter maps whatever the platform calls it into these four, and anything unrecognised
 * becomes UNKNOWN, which holds the entity (D13e).
 * VERIFY: real provision/reset state names, and whether a terminal FAILED can be re-driven.
 */
export const OPERATION_STATES = ['PENDING', 'SUCCEEDED', 'FAILED', 'UNKNOWN'] as const;
export type OperationState = (typeof OPERATION_STATES)[number];

export type ProvisionReq = {
  idempotencyKey: string;
  userId: string;
  productVersionId: string;
  accountSizeKobo: Kobo;
  platform: 'mt5';
  // VERIFY: the MT5 layer may need server/branch/login-group chosen at provisioning time.
};

export type ProvisionOutcome = {
  state: OperationState;
  login?: string;
  /**
   * Handle for the credential, never the credential itself. D11: MT5 passwords are shown
   * once at provisioning and are only re-issuable through a reset.
   */
  credentialHandle?: string;
};

export type ResetReq = {
  idempotencyKey: string;
  userId: string;
  login: string;
  accountId: string;
  reason: 'trader_request' | 'rule_reset';
};

export type ResetOutcome = {
  state: OperationState;
  /** New deadline granted by the platform, if the reset reports one. */
  phaseDeadline?: Date | null;
};

/** One closed position as reported by the platform. Display and reconciliation only. */
export type Trade = {
  /** The platform's own stable id for the trade, used to dedupe repeat pages. */
  platformTradeId: string;
  login: string;
  symbol: string;
  openedAt: Date;
  closedAt: Date | null;
  profitKobo: Kobo;
  /** Lot size as the platform writes it ("0.10"). A string because lots are decimal and
   * D2 forbids passing any money-shaped value through a float. VERIFY: precision and
   * trailing-zero rules once the spike shows a real payload. */
  lots: string;
};

export type TradePage = { trades: Trade[]; nextCursor: string | null };

export type TradeQuery = {
  login: string;
  from: Date;
  to: Date;
  cursor?: string;
  limit: number;
};

export interface TradingPlatformGateway {
  /** The only source of account status and numbers (D1, hard rule 5c). */
  getAccountState(login: string): Promise<Result<Sourced<AccountState>, GatewayError>>;
  requestProvision(req: ProvisionReq): Promise<Result<Sourced<Ticket>, GatewayError>>;
  getProvision(ticketId: string): Promise<Result<Sourced<ProvisionOutcome>, GatewayError>>;
  requestReset(req: ResetReq): Promise<Result<Sourced<Ticket>, GatewayError>>;
  getReset(ticketId: string): Promise<Result<Sourced<ResetOutcome>, GatewayError>>;
  listTrades(query: TradeQuery): Promise<Result<Sourced<TradePage>, GatewayError>>;
}

/** D9: identity lives upstream; this app only verifies and owns its own session. */
export type IdentityUser = {
  userId: string;
  email: string | null;
  phone: string | null;
  displayName: string | null;
};

export type VerifiedToken = { userId: string; expiresAt: Date };

export interface IdentityGateway {
  verifyToken(token: string): Promise<Result<Sourced<VerifiedToken>, GatewayError>>;
  getUser(userId: string): Promise<Result<Sourced<IdentityUser>, GatewayError>>;
}

/**
 * D6: narrowed to one processor once the spike names it. Until then the shape is ours, and
 * the adapter maps provider fields onto it.
 */
export type ChargeReq = {
  idempotencyKey: string;
  orderId: string;
  amountKobo: Kobo;
  /** Opaque reference to the customer. Hard rule 7: no PII crosses into fixtures or logs.
   * VERIFY: the processor's real init call (Paystack's `email`, Flutterwave's `tx_ref`). */
  customerRef: string;
};

export type Charge = {
  provider: string;
  providerRef: string;
  amountKobo: Kobo;
  status: PaymentStatus;
  paidAt: Date | null;
};

/** A verified webhook, already signature-checked. It only *triggers* a getCharge (D13f). */
export type ChargeEvent = {
  provider: string;
  /** Dedupe key with provider (D5, hard rule 4). */
  eventId: string;
  providerRef: string;
  amountKobo: Kobo | null;
  status: PaymentStatus;
};

export type WebhookInput = {
  /** Raw body bytes, exactly as received: signature verification must not use a reparsed object. */
  rawBody: string;
  headers: Readonly<Record<string, string | undefined>>;
};

export interface PaymentsGateway {
  initCharge(req: ChargeReq): Promise<Result<Sourced<Charge>, GatewayError>>;
  getCharge(providerRef: string): Promise<Result<Sourced<Charge>, GatewayError>>;
  verifyWebhook(input: WebhookInput): Promise<Result<Sourced<ChargeEvent>, GatewayError>>;
}

/** Re-exported so adapters can map breach reasons without importing the enum module twice. */
export type { AccountState, BreachReason, Kobo, PaymentStatus };
