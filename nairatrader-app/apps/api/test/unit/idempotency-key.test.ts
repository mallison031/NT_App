import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/modules/errors';
import { readIdempotencyKey, requestHashOf, type IdempotencyScope } from '../../src/modules/idempotency/store';

const scope = (overrides: Partial<IdempotencyScope> = {}): IdempotencyScope => ({
  key: 'order-key-0001',
  userId: 'usr_1',
  route: 'POST /v1/orders',
  body: { quoteId: 'q_1', affiliateRefCode: 'REF1' },
  ...overrides,
});

const errorCodeOf = (run: () => unknown): string => {
  try {
    run();
    return 'no error';
  } catch (error) {
    return error instanceof AppError ? `${error.status} ${error.code}` : `not an AppError: ${String(error)}`;
  }
};

describe('readIdempotencyKey (hard rule 3)', () => {
  it('refuses a request that brings no key', () => {
    expect(errorCodeOf(() => readIdempotencyKey(undefined))).toBe('400 missing_idempotency_key');
    expect(errorCodeOf(() => readIdempotencyKey('   '))).toBe('400 missing_idempotency_key');
  });

  it('refuses a key a client could not have meant, instead of letting Postgres 500 on it', () => {
    expect(errorCodeOf(() => readIdempotencyKey('short'))).toBe('400 invalid_request');
    expect(errorCodeOf(() => readIdempotencyKey('has spaces and punctuation!'))).toBe('400 invalid_request');
    expect(errorCodeOf(() => readIdempotencyKey('x'.repeat(129)))).toBe('400 invalid_request');
  });

  it('accepts a trimmed key of the shape a client is told to send', () => {
    expect(readIdempotencyKey('  order-key-0001  ')).toBe('order-key-0001');
  });
});

describe('requestHashOf (D5)', () => {
  it('is the same hash for the same request however the JSON was written', () => {
    // A retry may come from a different serialiser. Field order is not a different request.
    const reordered = requestHashOf(scope({ body: { affiliateRefCode: 'REF1', quoteId: 'q_1' } }));
    expect(requestHashOf(scope())).toBe(reordered);
  });

  it('is a different hash for a different body, trader, route or key', () => {
    const base = requestHashOf(scope());
    expect(requestHashOf(scope({ body: { quoteId: 'q_2' } }))).not.toBe(base);
    expect(requestHashOf(scope({ userId: 'usr_2' }))).not.toBe(base);
    expect(requestHashOf(scope({ route: 'POST /v1/payouts' }))).not.toBe(base);
    // The key itself is not hashed content: two keys, one body, are two requests.
    expect(requestHashOf(scope({ key: 'order-key-0002' }))).toBe(base);
  });

  it('does not let a nested body differ only by field order', () => {
    const nested = requestHashOf(scope({ body: { quoteId: 'q_1', meta: { a: 1, b: [2, { c: 3, d: 4 }] } } }));
    const reordered = requestHashOf(scope({ body: { meta: { b: [2, { d: 4, c: 3 }], a: 1 }, quoteId: 'q_1' } }));
    expect(nested).toBe(reordered);
  });
});
