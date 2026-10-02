import { describe, expect, it } from 'vitest';
import { ORDER_STATUSES, OrderStatus } from '@nt/shared';
import {
  IllegalOrderTransition,
  assertTransition,
  canTransition,
  isTerminal,
} from '../../src/modules/orders/state';

const ALL = ORDER_STATUSES;

describe('the order transition table (D7)', () => {
  it('allows the purchase path to be walked edge by edge', () => {
    expect(canTransition(OrderStatus.PendingPayment, OrderStatus.Paid)).toBe(true);
    expect(canTransition(OrderStatus.Paid, OrderStatus.Fulfilling)).toBe(true);
    expect(canTransition(OrderStatus.Fulfilling, OrderStatus.Fulfilled)).toBe(true);
  });

  it('refuses to skip a state the money path has not earned', () => {
    // Money is confirmed by a webhook and provisioning starts separately: a direct jump would let
    // a single write claim both facts at once.
    expect(canTransition(OrderStatus.PendingPayment, OrderStatus.Fulfilled)).toBe(false);
    expect(canTransition(OrderStatus.PendingPayment, OrderStatus.Fulfilling)).toBe(false);
    expect(canTransition(OrderStatus.Failed, OrderStatus.Paid)).toBe(false);
    expect(canTransition(OrderStatus.Fulfilled, OrderStatus.Failed)).toBe(false);
  });

  it('lets a held order go anywhere the truth turns out to be (D13c)', () => {
    const reachable = ALL.filter((status) => canTransition(OrderStatus.PendingReconcile, status));
    // Every forward state, plus the one it came from. A hold is not a fork with only one answer.
    expect(reachable).toEqual([
      OrderStatus.PendingPayment,
      OrderStatus.Paid,
      OrderStatus.Fulfilling,
      OrderStatus.Fulfilled,
      OrderStatus.Failed,
      OrderStatus.Expired,
    ]);
    expect(canTransition(OrderStatus.PendingReconcile, OrderStatus.PendingReconcile)).toBe(false);
  });

  it('has no way into REFUNDED, because refunds are not built', () => {
    for (const status of ALL) {
      expect(canTransition(status, OrderStatus.Refunded)).toBe(false);
    }
    expect(isTerminal(OrderStatus.Refunded)).toBe(true);
  });

  it('treats a closed order as closed', () => {
    for (const status of [OrderStatus.Fulfilled, OrderStatus.Failed, OrderStatus.Expired, OrderStatus.Refunded]) {
      expect(isTerminal(status)).toBe(true);
      for (const next of ALL) expect(canTransition(status, next)).toBe(false);
    }
  });

  it('accepts a move to the status the order already has', () => {
    for (const status of ALL) expect(() => assertTransition(status, status)).not.toThrow();
  });

  it('throws on an unlisted edge rather than answering a client error', () => {
    expect(() => assertTransition(OrderStatus.Fulfilled, OrderStatus.PendingPayment)).toThrowError(
      IllegalOrderTransition,
    );
    expect(() => assertTransition(OrderStatus.Failed, OrderStatus.Paid)).toThrow(
      'illegal order transition FAILED -> PAID',
    );
  });
});
