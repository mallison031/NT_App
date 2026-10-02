// D3, D4 and D5 in wire form. The purchase path moves money, so both halves of every message
// are pinned here: what a client may send (never a price, never a status) and what the API
// returns (money as decimal strings, timestamps as UTC ISO). The mobile client switches on
// these shapes, which is why they live in the shared package rather than in apps/api.

import { z } from 'zod';
import { ACCOUNT_STATUSES, ORDER_STATUSES, PAYMENT_STATUSES, PHASES } from '../enums';
import { isKoboString } from '../money';
import { UtcIsoString } from './account-state';

/** D4: a quote binds the trader to a price for fifteen minutes, and only a live quote may open an order. */
export const QUOTE_VALIDITY_MS = 15 * 60 * 1000;

/** D5: an Idempotency-Key keeps its request hash and response for twenty-four hours. */
export const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;

const KoboWireString = z
  .string()
  .refine(isKoboString, 'must be a decimal naira string with at most two fractional digits');

const Bps = z.number().int().nonnegative();

/** Rule phases only: UNKNOWN is what an unmapped *gateway* value becomes, never a rule row. */
const RulePhase = z.enum(PHASES.filter((phase) => phase !== 'UNKNOWN'));

/**
 * One entry of `ChallengeProductVersion.phaseRules`. The row is the rule (D3); this schema is
 * what makes a malformed row loud at the boundary instead of silently mis-displayed.
 */
export const PhaseRuleSchema = z.object({
  phase: RulePhase,
  profitTargetBps: Bps,
  maxDrawdownBps: Bps,
  dailyDrawdownBps: Bps.optional(),
  deadlineDays: z.number().int().positive().optional(),
});
export type PhaseRule = z.infer<typeof PhaseRuleSchema>;

export const PhaseRuleSetSchema = z.array(PhaseRuleSchema).min(1);

export type RulesParse = { ok: true; rules: PhaseRule[] } | { ok: false; issues: string[] };

/** Never throws: a bad rule row is reported, and the caller refuses to quote rather than guessing. */
export function parsePhaseRules(json: unknown): RulesParse {
  const parsed = PhaseRuleSetSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) =>
        `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`,
      ),
    };
  }
  return { ok: true, rules: parsed.data };
}

/**
 * A purchasable product version, flattened for the catalog screen. `priceKobo` is the only
 * price a client ever sees, and quoting it is the only way to get a charge amount (D4).
 */
export const CatalogOfferJsonSchema = z.object({
  productVersionId: z.string(),
  productSlug: z.string(),
  productName: z.string(),
  accountSizeKobo: KoboWireString,
  priceKobo: KoboWireString,
  phaseCount: z.number().int().positive(),
  phaseRules: PhaseRuleSetSchema,
  fundedDrawdownBps: Bps,
  profitShareBps: Bps,
  registrationRefundable: z.boolean(),
  resetAllowed: z.boolean(),
  effectiveFrom: UtcIsoString,
});
export type CatalogOfferJson = z.infer<typeof CatalogOfferJsonSchema>;

export const CatalogJsonSchema = z.object({
  offers: z.array(CatalogOfferJsonSchema),
  /** False when a rule row failed to parse: the offer is withheld rather than half-shown. */
  complete: z.boolean(),
});
export type CatalogJson = z.infer<typeof CatalogJsonSchema>;

/**
 * A client may name a product version and nothing else. Strict rather than tolerant: an extra
 * `priceKobo` in the body is a bug in the caller or an attempt to set its own price, and both
 * should fail loudly instead of being silently stripped (D4).
 */
export const CreateQuoteRequestSchema = z.strictObject({
  productVersionId: z.string().min(1).max(64),
});
export type CreateQuoteRequest = z.infer<typeof CreateQuoteRequestSchema>;

export const QuoteJsonSchema = z.object({
  id: z.string(),
  productVersionId: z.string(),
  amountKobo: KoboWireString,
  expiresAt: UtcIsoString,
  createdAt: UtcIsoString,
});
export type QuoteJson = z.infer<typeof QuoteJsonSchema>;

export const CreateOrderRequestSchema = z.strictObject({
  quoteId: z.string().min(1).max(64),
  affiliateRefCode: z.string().min(1).max(64).optional(),
});
export type CreateOrderRequest = z.infer<typeof CreateOrderRequestSchema>;

export const PaymentJsonSchema = z.object({
  provider: z.string(),
  providerRef: z.string(),
  amountKobo: KoboWireString,
  status: z.enum(PAYMENT_STATUSES),
});
export type PaymentJson = z.infer<typeof PaymentJsonSchema>;

/**
 * What fulfilment publishes about the account it provisioned. Deliberately no credential:
 * D11 allows the trader's own login, and the MT5 password is only ever handed out once, at
 * the moment of provisioning, through a path that does not store it in a read model.
 */
export const OrderAccountJsonSchema = z.object({
  id: z.string(),
  status: z.enum(ACCOUNT_STATUSES),
  login: z.string().nullable(),
});
export type OrderAccountJson = z.infer<typeof OrderAccountJsonSchema>;

export const OrderJsonSchema = z.object({
  id: z.string(),
  status: z.enum(ORDER_STATUSES),
  quoteId: z.string(),
  amountKobo: KoboWireString,
  createdAt: UtcIsoString,
  payment: PaymentJsonSchema.nullable(),
  account: OrderAccountJsonSchema.nullable(),
});
export type OrderJson = z.infer<typeof OrderJsonSchema>;

/**
 * Error codes the client is allowed to branch on. A gateway failure kind (D13c) reaches the
 * trader only through one of these: `transient` means "retry the same Idempotency-Key",
 * `reconciling` means "we stopped acting and are checking", and neither is a breach of money.
 */
export const API_ERROR_CODES = [
  'invalid_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'missing_idempotency_key',
  'idempotency_conflict',
  'offer_not_found',
  'offer_not_for_sale',
  'offer_rule_unreadable',
  'quote_not_found',
  'quote_expired',
  'quote_already_used',
  'payment_not_confirmed',
  'amount_mismatch',
  'gateway_transient',
  'reconciling',
  'gateway_unavailable',
  /** Nothing the client can act on: this build failed, not the request. */
  'internal_error',
] as const;

export const ApiErrorJsonSchema = z.object({
  code: z.enum(API_ERROR_CODES),
  /** Operator-facing and safe to show; never a raw gateway detail (hard rule 7). */
  message: z.string(),
});
export type ApiErrorJson = z.infer<typeof ApiErrorJsonSchema>;
export type ApiErrorCode = z.infer<typeof ApiErrorJsonSchema>['code'];
