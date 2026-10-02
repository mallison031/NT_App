import { describe, expect, it } from 'vitest';
import { QUOTE_VALIDITY_MS } from '@nt/shared';
import { isQuoteExpired } from '../../src/modules/quotes/service';

const CREATED = new Date('2026-04-01T09:00:00Z');
/** A quote taken at `CREATED` is dead once `expiresAt` is behind the clock. */
const DEADLINE = new Date(CREATED.getTime() + QUOTE_VALIDITY_MS);
const at = (ms: number): Date => new Date(CREATED.getTime() + ms);

describe('quote expiry (D4)', () => {
  it('holds the price for the whole fifteen minutes', () => {
    expect(isQuoteExpired(DEADLINE, at(0))).toBe(false);
    expect(isQuoteExpired(DEADLINE, at(QUOTE_VALIDITY_MS - 1))).toBe(false);
  });

  it('stops holding it at the instant the deadline passes', () => {
    // The deadline itself counts as expired: at 09:15:00.000 the quoted price is no longer the
    // price, and a purchase may not be decided on the difference between two clock reads.
    expect(isQuoteExpired(DEADLINE, DEADLINE)).toBe(true);
    expect(isQuoteExpired(DEADLINE, at(QUOTE_VALIDITY_MS + 1))).toBe(true);
  });

  it('binds a quote for the period the shared schema names', () => {
    expect(QUOTE_VALIDITY_MS).toBe(15 * 60 * 1000);
  });
});
