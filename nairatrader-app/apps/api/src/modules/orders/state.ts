// D7 applied to orders: a status only moves along a listed edge, and an unlisted edge throws.
// PENDING_RECONCILE is a real state in this table rather than a flag, because D13c says a lost
// answer is neither success nor failure — and the only safe way back out of it is to allow every
// edge the reconciliation could honestly discover.
//
// REFUNDED has no inbound edge here. Refunds are not built (Phase 3+), and an edge nobody can
// reach is how a state machine starts lying about itself.

import { OrderStatus } from '@nt/shared';

const EDGES: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  [OrderStatus.PendingPayment]: [OrderStatus.Paid, OrderStatus.PendingReconcile, OrderStatus.Failed, OrderStatus.Expired],
  [OrderStatus.Paid]: [OrderStatus.Fulfilling, OrderStatus.PendingReconcile, OrderStatus.Failed],
  [OrderStatus.Fulfilling]: [OrderStatus.Fulfilled, OrderStatus.PendingReconcile, OrderStatus.Failed],
  // Whatever the reconcile pass confirms decides where a held order goes, including back to where
  // it was before the answer was lost.
  [OrderStatus.PendingReconcile]: [
    OrderStatus.PendingPayment,
    OrderStatus.Paid,
    OrderStatus.Fulfilling,
    OrderStatus.Fulfilled,
    OrderStatus.Failed,
    OrderStatus.Expired,
  ],
  [OrderStatus.Fulfilled]: [],
  [OrderStatus.Failed]: [],
  [OrderStatus.Expired]: [],
  [OrderStatus.Refunded]: [],
};

export const canTransition = (from: OrderStatus, to: OrderStatus): boolean => EDGES[from].includes(to);

export const isTerminal = (status: OrderStatus): boolean => EDGES[status].length === 0;

/**
 * Refuses an illegal move before a write happens. This is an invariant, not a client error: an
 * unlisted edge means this build is wrong about its own state machine, so it throws rather than
 * answering 4xx (D7).
 */
export class IllegalOrderTransition extends Error {
  public constructor(from: OrderStatus, to: OrderStatus) {
    super(`illegal order transition ${from} -> ${to}`);
    this.name = 'IllegalOrderTransition';
  }
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (from === to) return;
  if (!canTransition(from, to)) throw new IllegalOrderTransition(from, to);
}
