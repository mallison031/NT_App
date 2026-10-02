// F2, D4, D5 and D13f in one file: the only path that turns a quote into money moving.
//
// Transaction boundary, stated plainly because CLAUDE.md asks for it: the database work is one
// transaction that writes Order + TradingAccount + AccountRuleSnapshot + AuditLog and nothing
// else. No gateway call happens inside it — a transaction held across a network call is how a
// slow processor becomes a lock convoy. So the shape is: commit the order, then call initCharge,
// then write what the processor said.
//
// Idempotency, three layers, each doing a different job:
//   1. the Idempotency-Key record (modules/idempotency) replays the *response*;
//   2. Order.idempotencyKey and Order.quoteId are unique, so a lost or expired record still
//      cannot open a second order for one quote;
//   3. the charge key is derived from the order id, so re-driving a half-finished order asks the
//      processor to do the same thing again rather than charging the trader twice.

import type { PrismaClient } from '@prisma/client';
import { koboToString, type CatalogOfferJson, type Kobo, type OrderJson, PaymentStatus } from '@nt/shared';
import type { PaymentsGateway } from '../../gateways/types';
import { AppError, gatewayTransient, gatewayUnavailable } from '../errors';
import { isUniqueViolation } from '../../db';
import { recordAudit } from '../audit';
import { redeemableQuote } from '../quotes/service';
import { ORDER_RELATIONS, loadOrder, orderToJson, type OrderWithRelations } from './view';
import { assertTransition } from './state';

export type OrderDeps = {
  prisma: PrismaClient;
  payments: PaymentsGateway;
  /** Which gateway is wired in, from env. Only used to name a payment row the processor never
   * confirmed; a confirmed charge carries its own provider name. */
  paymentsProvider: string;
  clock: () => Date;
};

export type PlaceOrderInput = {
  userId: string;
  idempotencyKey: string;
  quoteId: string;
  affiliateRefCode?: string;
};

export type OrderOutcome = { status: number; body: OrderJson };

/** The only amount ever charged: the quote's. Nothing in this file derives a price (D4). */
const chargeKeyOf = (orderId: string): string => `order:${orderId}:charge`;

/** Opaque customer reference: an order id, so no PII reaches the processor or a fixture (hard rule 7). */
const customerRefOf = (orderId: string): string => `cus_${orderId}`;

export async function placeOrder(deps: OrderDeps, input: PlaceOrderInput): Promise<OrderOutcome> {
  const existing = await findOrderByQuote(deps.prisma, input.quoteId);
  if (existing) return resumeWith(deps, existing, input);

  const { quote, offer } = await redeemableQuote(deps.prisma, input.quoteId, input.userId, deps.clock());
  const opened = await openOrder(deps, {
    userId: input.userId,
    idempotencyKey: input.idempotencyKey,
    quote,
    offer,
    affiliateRefCode: input.affiliateRefCode,
  });
  return driveCharge(deps, opened.order, opened.created ? 201 : 200);
}

const findOrderByQuote = (prisma: PrismaClient, quoteId: string): Promise<OrderWithRelations | null> =>
  prisma.order.findUnique({ where: { quoteId }, include: ORDER_RELATIONS });

/**
 * The same quote and key arriving again means the first attempt did not finish — a lost response,
 * an expired idempotency record, or a transient refusal. Re-drive the charge rather than opening a
 * second order.
 */
async function resumeWith(
  deps: OrderDeps,
  order: OrderWithRelations,
  input: PlaceOrderInput,
): Promise<OrderOutcome> {
  if (order.userId !== input.userId) throw new AppError('quote_not_found', 404, 'no such quote');
  if (order.idempotencyKey !== input.idempotencyKey) {
    throw new AppError('quote_already_used', 409, 'this quote already has an order');
  }
  return driveCharge(deps, order, 200);
}

type OpenOrderInput = {
  userId: string;
  idempotencyKey: string;
  quote: { id: string; amountKobo: Kobo; versionId: string };
  offer: CatalogOfferJson;
  affiliateRefCode?: string;
};

/**
 * Order + account + frozen rules, in one transaction.
 *
 * The account row is created here rather than at provisioning so the rule snapshot exists at the
 * moment of purchase (D3: "on purchase, copy into AccountRuleSnapshot"). Its status is
 * PENDING_PROVISION, which is *our* provisioning state and not a platform judgement (D1); the
 * evaluation/breach/funded status arrives later from the Account State Contract, in Phase 4.
 */
async function openOrder(
  deps: OrderDeps,
  input: OpenOrderInput,
): Promise<{ order: OrderWithRelations; created: boolean }> {
  try {
    const created = await deps.prisma.$transaction(async (tx) => {
      const order = await tx.order.create({
        data: {
          userId: input.userId,
          quoteId: input.quote.id,
          idempotencyKey: input.idempotencyKey,
          affiliateRefCode: input.affiliateRefCode,
          status: 'PENDING_PAYMENT',
          account: {
            create: {
              userId: input.userId,
              status: 'PENDING_PROVISION',
              ruleSnapshot: { create: { versionId: input.quote.versionId, rules: input.offer } },
            },
          },
        },
        include: ORDER_RELATIONS,
      });
      await recordAudit(tx, {
        actor: input.userId,
        action: 'order.created',
        entity: 'Order',
        entityId: order.id,
        after: { quoteId: input.quote.id, amountKobo: koboToString(input.quote.amountKobo), productVersionId: input.quote.versionId },
      });
      return order;
    });
    return { order: created, created: true };
  } catch (error) {
    // Two requests with one key raced: the loser adopts the winner's order rather than failing,
    // and the answer it returns is the order that really exists.
    if (!isUniqueViolation(error)) throw error;
    const loser = await findOrderByQuote(deps.prisma, input.quote.id);
    if (!loser) throw error;
    return { order: loser, created: false };
  }
}

/**
 * Ask the processor to charge the quoted amount, then record exactly what it said. Each of the
 * four failure kinds (D13c) gets the treatment the decision specifies, and none of them is
 * "retry the write": an unknown answer is reconciled, not repeated.
 */
async function driveCharge(deps: OrderDeps, order: OrderWithRelations, okStatus: number): Promise<OrderOutcome> {
  // Only an order that never got a charge answer may be re-driven. Anything else already has a
  // recorded outcome, and asking the processor again would repeat a decision that has been made.
  if (order.status !== 'PENDING_PAYMENT') return { status: 200, body: orderToJson(order) };

  const amountKobo = order.quote.amountKobo;
  const result = await deps.payments.initCharge({
    idempotencyKey: chargeKeyOf(order.id),
    orderId: order.id,
    amountKobo,
    customerRef: customerRefOf(order.id),
  });

  if (result.ok) {
    const charge = result.value.data;
    if (!result.value.complete) {
      // D13b: an incomplete answer may not be written up as an initiated charge.
      return holdForReconcile(deps, order, charge.provider, charge.providerRef, 'the processor answered, but not with a whole charge');
    }
    // D13f's confirmation applies on the way in too: a charge created for a different amount than
    // the quote is not the charge the trader agreed to.
    if (charge.amountKobo !== amountKobo) {
      await recordMismatch(deps, order, charge.provider, charge.providerRef, charge.amountKobo);
      throw new AppError(
        'amount_mismatch',
        409,
        'the charge amount does not match your quote',
        `order ${order.id}: quoted ${koboToString(amountKobo)}, charged ${koboToString(charge.amountKobo)}`,
      );
    }

    const stored = await recordPayment(
      deps,
      order.id,
      charge.provider,
      charge.providerRef,
      charge.amountKobo,
      charge.status,
    );
    if (stored === null) {
      return holdForReconcile(
        deps,
        order,
        charge.provider,
        null,
        `the processor returned charge ${charge.providerRef}, which this app already holds for another order`,
      );
    }
    const reloaded = await loadOrder(deps.prisma, order.id, order.userId);
    return { status: okStatus, body: orderToJson(reloaded) };
  }

  switch (result.error) {
    case 'transient':
      // Nothing was created, the order stays where it is, and the client retries the same key.
      throw gatewayTransient(
        'the payment provider is briefly unavailable; retry with the same Idempotency-Key',
        result.detail,
      );
    case 'unsupported':
      // D13c: a missing capability is feature-off, not a failed purchase. The order and its quote
      // stay untouched so nothing is burned while the feature is off.
      throw gatewayUnavailable('payments are not available on this processor build', result.detail);
    case 'permanent': {
      await failOrder(deps, order, `the payment provider refused the charge: ${result.detail ?? 'no detail'}`);
      throw new AppError('gateway_unavailable', 502, 'the payment provider refused the charge', result.detail);
    }
    case 'unknown_outcome': {
      // The charge may exist and money may be moving. Hold, and keep the handle (D13c).
      const providerRef = result.ref;
      if (providerRef === undefined) {
        // A lost write with nothing to query by is the worst case in this file: it is held anyway,
        // and ops finds it through the order rather than through a retry.
        return holdForReconcile(deps, order, deps.paymentsProvider, null, 'the charge answer was lost and the processor returned no handle');
      }
      return holdForReconcile(deps, order, deps.paymentsProvider, providerRef, 'the charge answer was lost after the processor took it');
    }
  }
}

async function recordPayment(
  deps: OrderDeps,
  orderId: string,
  provider: string,
  providerRef: string,
  amountKobo: Kobo,
  status: PaymentStatus,
): Promise<string | null> {
  // (provider, providerRef) is the dedupe key (hard rule 4), so a replayed answer for *this* order
  // updates rather than adding a second charge row. A reference that already belongs to another
  // order is a different matter: the processor's answer contradicts what this database says, and
  // writing over it would move a payment that is already accounted for — including one already
  // SUCCEEDED. Nothing is written and the caller holds (D13c).
  const claimed = await deps.prisma.payment.findUnique({
    where: { provider_providerRef: { provider, providerRef } },
    select: { orderId: true },
  });
  if (claimed !== null && claimed.orderId !== orderId) return null;

  await deps.prisma.payment.upsert({
    where: { provider_providerRef: { provider, providerRef } },
    create: { orderId, provider, providerRef, amountKobo, status },
    update: { status },
  });
  await recordAudit(deps.prisma, {
    actor: 'system',
    action: 'order.charge_initiated',
    entity: 'Order',
    entityId: orderId,
    after: { provider, providerRef, amountKobo: koboToString(amountKobo), status },
  });
  return providerRef;
}

/** D13f/D4: the provider holds a different amount than the quote. Recorded, never charged blind. */
async function recordMismatch(
  deps: OrderDeps,
  order: OrderWithRelations,
  provider: string,
  providerRef: string,
  chargedKobo: Kobo,
): Promise<void> {
  const recorded = await recordPayment(deps, order.id, provider, providerRef, chargedKobo, PaymentStatus.AmountMismatch);
  await recordAudit(deps.prisma, {
    actor: 'system',
    action: 'order.amount_mismatch',
    entity: 'Order',
    entityId: order.id,
    after: { quotedKobo: koboToString(order.quote.amountKobo), chargedKobo: koboToString(chargedKobo), recorded },
  });
}

async function holdForReconcile(
  deps: OrderDeps,
  order: OrderWithRelations,
  provider: string,
  providerRef: string | null,
  why: string,
): Promise<OrderOutcome> {
  assertTransition(order.status, 'PENDING_RECONCILE');
  // The handle is kept even though the amount is unconfirmed, because it is what the reconcile
  // pass queries (D13c). The row's status says UNKNOWN rather than INITIATED (D13e). A handle that
  // another order already owns is not kept, and the audit says so by recording null.
  const stored =
    providerRef === null
      ? null
      : await recordPayment(deps, order.id, provider, providerRef, order.quote.amountKobo, PaymentStatus.Unknown);
  const updated = await deps.prisma.order.update({
    where: { id: order.id },
    data: { status: 'PENDING_RECONCILE' },
    include: ORDER_RELATIONS,
  });
  await recordAudit(deps.prisma, {
    actor: 'system',
    action: 'order.pending_reconcile',
    entity: 'Order',
    entityId: order.id,
    after: { reason: why, providerRef: stored, before: order.status },
  });
  // 202 rather than an error: the order exists, the money question is open, and polling is the
  // client's next move.
  return { status: 202, body: orderToJson(updated) };
}

async function failOrder(deps: OrderDeps, order: OrderWithRelations, reason: string): Promise<void> {
  assertTransition(order.status, 'FAILED');
  await deps.prisma.order.update({ where: { id: order.id }, data: { status: 'FAILED' } });
  await recordAudit(deps.prisma, {
    actor: 'system',
    action: 'order.failed',
    entity: 'Order',
    entityId: order.id,
    after: { reason },
  });
}
