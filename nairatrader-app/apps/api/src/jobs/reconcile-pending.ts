// D13c, for the orders this build had to stop trusting itself about. A lost charge answer or a
// provisioning ticket that never came back leaves an order in FULFILLING or PENDING_RECONCILE, and
// nothing in the request path will ever touch it again: the trader has stopped polling, the webhook
// has been spent. This pass is what closes the loop.
//
// The rule it exists to enforce is that reconciliation re-asks a question and never re-issues a
// write. Money questions are settled by reading the charge back through the handle we kept
// (D13f), and provisioning is driven through the same order-derived idempotency key, so a
// re-drive hands back the ticket that already exists rather than a second account.
//
// Why there is no worker entrypoint here yet: a real deployment runs this on a timer in the second
// container D12 describes. The Fake gateways keep their world in process memory, so a separate
// process would report every charge as "the processor does not know this". Until a real adapter
// exists the pass is reachable from inside the API process — as a function, and through the
// dev-only reconcile route.

import { OrderStatus, PaymentStatus } from '@nt/shared';
import { recordAudit } from '../modules/audit';
import { advanceFulfilment } from '../modules/orders/fulfilment';
import { assertTransition } from '../modules/orders/state';
import { ORDER_RELATIONS, type OrderWithRelations } from '../modules/orders/view';
import { confirmCharge, type WebhookDeps } from '../modules/payments/webhook';

/** Exactly what the webhook path needs: the two gateways, the database and a clock. */
export type ReconcileDeps = WebhookDeps;

/**
 * Every status that means "this order is waiting on an answer we have not finished getting".
 * PAID is in the list because a confirmation and the start of provisioning are two writes, and a
 * crash between them leaves a paid order that would otherwise never be worked on again.
 */
const RECONCILABLE = [OrderStatus.Paid, OrderStatus.Fulfilling, OrderStatus.PendingReconcile] as const;

/** A payment whose stored status is a question rather than an answer. */
const OPEN_PAYMENTS: readonly PaymentStatus[] = [PaymentStatus.Unknown, PaymentStatus.Initiated];

/** How many orders one pass touches, oldest first: a held order is never starved by a new one. */
export const RECONCILE_BATCH_SIZE = 50;

export type ReconcileResult =
  | 'fulfilled'
  | 'awaiting_ticket'
  | 'declined'
  | 'held'
  | 'needs_attention';

export type ReconciledOrder = { orderId: string; result: ReconcileResult; reason: string };

export type ReconcileReport = { scanned: number; results: ReconciledOrder[] };

export async function reconcilePendingOrders(
  deps: ReconcileDeps,
  limit: number = RECONCILE_BATCH_SIZE,
): Promise<ReconcileReport> {
  const orders = await deps.prisma.order.findMany({
    where: { status: { in: [...RECONCILABLE] } },
    include: ORDER_RELATIONS,
    orderBy: { createdAt: 'asc' },
    take: limit,
  });

  const results: ReconciledOrder[] = [];
  // One order at a time: the pass is a slow reader of a live money path, and a batch of
  // concurrent confirmations would compete with the webhook deliveries for the same row locks.
  for (const order of orders) results.push(await reconcileOrder(deps, order));
  return { scanned: orders.length, results };
}

/**
 * Every branch here returns a report instead of throwing: one order whose provider answer is
 * unreadable may not stop the other forty-nine.
 */
async function reconcileOrder(deps: ReconcileDeps, order: OrderWithRelations): Promise<ReconciledOrder> {
  try {
    const payment = order.payments[0];
    if (payment !== undefined && OPEN_PAYMENTS.includes(payment.status)) {
      return await resolvePayment(deps, order, payment.providerRef);
    }
    if (order.status === OrderStatus.Paid || order.status === OrderStatus.Fulfilling) {
      return await driveProvisioning(deps, order.id);
    }
    return await resumeProvisioning(deps, order);
  } catch (error) {
    return report(order.id, 'needs_attention', `reconcile stopped: ${messageOf(error)}`);
  }
}

/**
 * The charge we recorded is still an open question, so ask the processor what it holds. The
 * decision is the webhook's decision (same function, same lock), with no delivery to close.
 */
async function resolvePayment(
  deps: ReconcileDeps,
  order: OrderWithRelations,
  providerRef: string,
): Promise<ReconciledOrder> {
  const answer = await deps.payments.getCharge(providerRef);
  if (!answer.ok) return await chargeRefused(deps, order, providerRef, answer.error, answer.detail);
  if (!answer.value.complete) {
    return report(order.id, 'held', 'the processor answered the charge read, but not with a whole charge');
  }

  const outcome = await confirmCharge(deps, answer.value.data, null);
  if (outcome.effect === 'paid') return await driveProvisioning(deps, outcome.orderId ?? order.id);
  // An unmapped or unfinished provider status keeps the order parked; that is the pass working.
  if (outcome.effect === 'held') return report(order.id, 'held', 'the charge is still not a status this build can act on');
  if (outcome.effect === 'declined') return report(order.id, 'declined', 'the charge was declined; the order is closed');
  return report(order.id, 'needs_attention', `the charge resolved as ${outcome.effect}`);
}

async function chargeRefused(
  deps: ReconcileDeps,
  order: OrderWithRelations,
  providerRef: string,
  error: 'transient' | 'permanent' | 'unsupported' | 'unknown_outcome',
  detail: string | undefined,
): Promise<ReconciledOrder> {
  if (error !== 'permanent') {
    return report(order.id, 'held', `the charge could not be read (${error})`);
  }
  // The processor does not know this reference. The one thing D13c forbids is re-issuing the
  // charge to see what happens, and the one thing that remains is a written-down question.
  await recordAudit(deps.prisma, {
    actor: 'system',
    action: 'reconcile.charge_denied',
    entity: 'Order',
    entityId: order.id,
    after: { providerRef, reason: detail ?? 'the processor does not know this charge' },
  });
  return report(order.id, 'needs_attention', `the processor does not know charge ${providerRef}`);
}

/**
 * A hold whose money question is already settled was a provisioning hold, so the order goes back
 * to FULFILLING and the ticket path runs again — through the same key, which is what makes the
 * re-drive safe rather than duplicative.
 */
async function resumeProvisioning(
  deps: ReconcileDeps,
  order: OrderWithRelations,
): Promise<ReconciledOrder> {
  const payment = order.payments[0];
  if (payment === undefined) {
    return report(order.id, 'needs_attention', 'held with no payment row, so its money question cannot be read back');
  }
  if (payment.status === PaymentStatus.Succeeded) {
    assertTransition(order.status, OrderStatus.Fulfilling);
    await deps.prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.Fulfilling } });
      await recordAudit(tx, {
        actor: 'system',
        action: 'reconcile.resumed',
        entity: 'Order',
        entityId: order.id,
        before: { status: order.status },
        after: { status: OrderStatus.Fulfilling, reason: 'the charge is confirmed; provisioning is what is outstanding' },
      });
    });
    return await driveProvisioning(deps, order.id);
  }
  if (payment.status === PaymentStatus.Failed) {
    return report(order.id, 'declined', 'the stored charge failed and the order is held');
  }
  return report(order.id, 'needs_attention', `held with a stored charge status of ${payment.status}`);
}

/**
 * Ask the platform for the account, or poll the ticket we already hold (D13d), then report the
 * status that actually ended up on the row — advanceFulfilment may close the order, leave it open,
 * or hold it.
 */
async function driveProvisioning(deps: ReconcileDeps, orderId: string): Promise<ReconciledOrder> {
  await advanceFulfilment(deps, orderId);
  const after = await deps.prisma.order.findUnique({ where: { id: orderId }, include: ORDER_RELATIONS });
  if (!after) return report(orderId, 'needs_attention', 'the order disappeared during reconciliation');
  return classify(after);
}

function classify(order: OrderWithRelations): ReconciledOrder {
  switch (order.status) {
    case OrderStatus.Fulfilled:
      return report(order.id, 'fulfilled', 'the account is provisioned');
    case OrderStatus.Fulfilling:
      return report(order.id, 'awaiting_ticket', 'the platform has not finished provisioning yet');
    case OrderStatus.PendingReconcile:
      return report(order.id, 'held', 'provisioning could not be decided; the order stays parked');
    case OrderStatus.Failed:
      return report(order.id, 'declined', 'the order is closed');
    default:
      return report(order.id, 'needs_attention', `an order this pass was not expecting: ${order.status}`);
  }
}

const report = (orderId: string, result: ReconcileResult, reason: string): ReconciledOrder => ({
  orderId,
  result,
  reason,
});

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : 'unknown error');
