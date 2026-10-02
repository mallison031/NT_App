import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_STATUSES,
  AccountStatus,
  BREACH_REASONS,
  BreachReason,
  NOTIFICATION_TYPES,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  PAYOUT_STATUSES,
  PayoutStatus,
  PHASES,
  Phase,
  RESET_STATUSES,
  TICKET_STATUSES,
} from '../src/index';

const groups = [
  ACCOUNT_STATUSES,
  PHASES,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  PAYOUT_STATUSES,
  RESET_STATUSES,
  TICKET_STATUSES,
  BREACH_REASONS,
  NOTIFICATION_TYPES,
];

describe('shared enums', () => {
  it('uses database values in SCREAMING_SNAKE_CASE', () => {
    for (const values of groups) {
      for (const value of values) {
        expect(value).toMatch(/^[A-Z][A-Z0-9_]*$/);
      }
    }
  });

  it('has no duplicate database values inside a group', () => {
    for (const values of groups) {
      expect(new Set(values).size).toBe(values.length);
    }
  });

  // D13e: every externally-mapped enum needs an UNKNOWN, not just the account status.
  // A payout reason or a phase the adapter has never seen must be holdable, not guessed.
  it('keeps UNKNOWN available for unmapped gateway values (D13e)', () => {
    expect(ACCOUNT_STATUSES).toContain(AccountStatus.Unknown);
    expect(PHASES).toContain(Phase.Unknown);
    expect(BREACH_REASONS).toContain(BreachReason.Unknown);
  });

  it('keeps PENDING_RECONCILE on the money paths D13c holds open', () => {
    expect(ORDER_STATUSES).toContain('PENDING_RECONCILE');
    expect(RESET_STATUSES).toContain('PENDING_RECONCILE');
    expect(PAYOUT_STATUSES).toContain(PayoutStatus.PendingReconcile);
  });
});
