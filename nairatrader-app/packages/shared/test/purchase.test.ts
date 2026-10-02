import { describe, expect, it } from 'vitest';
import {
  API_ERROR_CODES,
  ApiErrorJsonSchema,
  CatalogOfferJsonSchema,
  CreateOrderRequestSchema,
  CreateQuoteRequestSchema,
  IDEMPOTENCY_RETENTION_MS,
  OrderJsonSchema,
  parsePhaseRules,
  QUOTE_VALIDITY_MS,
  QuoteJsonSchema,
} from '../src/schemas/purchase';

const offer = () => ({
  productVersionId: 'pver_1',
  productSlug: 'demo-500k',
  productName: 'DEMO 500K',
  accountSizeKobo: '500000000.00',
  priceKobo: '2500.00',
  phaseCount: 2,
  phaseRules: [
    { phase: 'EVAL_1', profitTargetBps: 3000, maxDrawdownBps: 500, deadlineDays: 60 },
    { phase: 'EVAL_2', profitTargetBps: 5000, maxDrawdownBps: 500 },
  ],
  fundedDrawdownBps: 1000,
  profitShareBps: 7000,
  registrationRefundable: false,
  resetAllowed: true,
  effectiveFrom: '2026-04-01T00:00:00Z',
});

describe('rule rows are data, and bad data is refused at the boundary (D3)', () => {
  it('accepts a rule set that names phases, targets and drawdowns', () => {
    const parsed = parsePhaseRules(offer().phaseRules);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.rules[0]?.profitTargetBps).toBe(3000);
  });

  it('refuses an empty rule set rather than offering an account with no rules', () => {
    const parsed = parsePhaseRules([]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues.join(' ')).toContain('(root)');
  });

  it('refuses an unknown phase spelling, since the app renders rules rather than translating them', () => {
    const parsed = parsePhaseRules([{ phase: 'EVAL_9', profitTargetBps: 3000, maxDrawdownBps: 500 }]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues.join(' ')).toContain('phase');
  });

  it('refuses UNKNOWN as a rule phase: that value belongs to gateway mapping, not to a product', () => {
    expect(parsePhaseRules([{ phase: 'UNKNOWN', profitTargetBps: 1, maxDrawdownBps: 1 }]).ok).toBe(false);
  });

  it('refuses a fractional basis-point rule, which is how a float would creep back in (D2)', () => {
    const parsed = parsePhaseRules([{ phase: 'EVAL_1', profitTargetBps: 30.5, maxDrawdownBps: 500 }]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues.join(' ')).toContain('profitTargetBps');
  });

  it('refuses a negative drawdown limit', () => {
    expect(parsePhaseRules([{ phase: 'EVAL_1', profitTargetBps: 1, maxDrawdownBps: -1 }]).ok).toBe(false);
  });

  it('reports every problem rather than only the first, so a seeded row can be fixed in one pass', () => {
    const parsed = parsePhaseRules([{ phase: 'NOPE', profitTargetBps: -2, maxDrawdownBps: 1.5 }]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues.length).toBeGreaterThanOrEqual(3);
  });

  it('never throws on shapes a Json column can actually hold', () => {
    for (const value of [null, undefined, 'rules', 3, {}, [{ phase: 'EVAL_1' }]]) {
      expect(() => parsePhaseRules(value)).not.toThrow();
    }
  });
});

describe('money and instants keep their wire forms in purchase payloads (D2)', () => {
  it('accepts a well-formed offer', () => {
    expect(CatalogOfferJsonSchema.safeParse(offer()).success).toBe(true);
  });

  for (const amount of [250_000, '2500.000', '1e3', 'NaN', '2,500.00', '', '-']) {
    it(`refuses priceKobo ${JSON.stringify(amount)} on the wire`, () => {
      expect(CatalogOfferJsonSchema.safeParse({ ...offer(), priceKobo: amount }).success).toBe(false);
    });
  }

  it('refuses an offer whose rule array would not round-trip', () => {
    expect(CatalogOfferJsonSchema.safeParse({ ...offer(), phaseRules: [] }).success).toBe(false);
  });

  it('requires a UTC instant for quote expiry, not an offset the client would reinterpret', () => {
    expect(QuoteJsonSchema.safeParse({
      id: 'q1',
      productVersionId: 'pver_1',
      amountKobo: '2500.00',
      expiresAt: '2026-04-01T08:45:00+01:00',
      createdAt: '2026-04-01T08:30:00Z',
    }).success).toBe(false);
  });

  it('keeps an order status inside the enum the schema and @nt/shared agree on', () => {
    const base = {
      id: 'ord_1',
      status: 'PAID',
      quoteId: 'q1',
      amountKobo: '2500.00',
      createdAt: '2026-04-01T08:30:00Z',
      payment: null,
      account: null,
    };
    expect(OrderJsonSchema.safeParse(base).success).toBe(true);
    expect(OrderJsonSchema.safeParse({ ...base, status: 'HALF_PAID' }).success).toBe(false);
    expect(OrderJsonSchema.safeParse({ ...base, amountKobo: 250_000 }).success).toBe(false);
  });

  it('lets an account carry no login yet, because provisioning is a ticket (D13d)', () => {
    expect(
      OrderJsonSchema.safeParse({
        id: 'ord_1',
        status: 'FULFILLING',
        quoteId: 'q1',
        amountKobo: '2500.00',
        createdAt: '2026-04-01T08:30:00Z',
        payment: { provider: 'fake', providerRef: 'chg_1', amountKobo: '2500.00', status: 'SUCCEEDED' },
        account: { id: 'acc_1', status: 'PENDING_PROVISION', login: null },
      }).success,
    ).toBe(true);
  });
});

describe('requests carry intent only', () => {
  it('accepts a quote request naming a product version and nothing else', () => {
    expect(CreateQuoteRequestSchema.safeParse({ productVersionId: 'pver_1' }).success).toBe(true);
  });

  for (const body of [{}, { productVersionId: '' }, { productVersionId: 'pver_1', priceKobo: '1.00' }, null]) {
    it(`refuses the quote request ${JSON.stringify(body)}`, () => {
      expect(CreateQuoteRequestSchema.safeParse(body).success).toBe(false);
    });
  }

  it('refuses an order request that tries to bring its own amount (D4)', () => {
    expect(CreateOrderRequestSchema.safeParse({ quoteId: 'q1', affiliateRefCode: 'REF1' }).success).toBe(true);
    expect(CreateOrderRequestSchema.safeParse({ quoteId: 'q1', amountKobo: '1.00' }).success).toBe(false);
  });

  it('gives every error code a message the client can show', () => {
    for (const code of API_ERROR_CODES) {
      expect(ApiErrorJsonSchema.safeParse({ code, message: 'try again' }).success).toBe(true);
    }
    expect(ApiErrorJsonSchema.safeParse({ code: 'breached', message: 'x' }).success).toBe(false);
  });
});

describe('the constants decisions D4 and D5 name', () => {
  it('binds a quote for fifteen minutes', () => {
    expect(QUOTE_VALIDITY_MS).toBe(15 * 60 * 1000);
  });

  it('keeps an idempotency record for a day', () => {
    expect(IDEMPOTENCY_RETENTION_MS).toBe(24 * 60 * 60 * 1000);
  });
});
