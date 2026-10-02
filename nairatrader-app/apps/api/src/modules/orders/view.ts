// The order read model. One place builds an order's JSON so a client cannot see two different
// shapes for the same thing depending on which route answered it, and so kobo conversion happens
// exactly the way D2 requires (through money.ts, never by hand).

import type { Prisma, PrismaClient } from '@prisma/client';
import { koboToString, toUtcIsoString, type OrderJson } from '@nt/shared';
import { notFound } from '../errors';

export const ORDER_RELATIONS = {
  quote: true,
  // The rule snapshot travels with the account because provisioning reads the size the trader
  // actually bought out of it (D3). The read model itself never shows it.
  account: { include: { ruleSnapshot: true } },
  // The newest payment is the one a trader is asking about; the rest is history the read model
  // does not show. v1 writes at most one row per order anyway.
  payments: { orderBy: { createdAt: 'desc' }, take: 1 },
} as const satisfies Prisma.OrderInclude;

export type OrderWithRelations = Prisma.OrderGetPayload<{ include: typeof ORDER_RELATIONS }>;

export const orderToJson = (order: OrderWithRelations): OrderJson => {
  const payment = order.payments[0];
  return {
    id: order.id,
    status: order.status,
    quoteId: order.quoteId,
    amountKobo: koboToString(order.quote.amountKobo),
    createdAt: toUtcIsoString(order.createdAt),
    payment: payment
      ? {
          provider: payment.provider,
          providerRef: payment.providerRef,
          amountKobo: koboToString(payment.amountKobo),
          status: payment.status,
        }
      : null,
    account: order.account
      ? { id: order.account.id, status: order.account.status, login: order.account.mtLogin }
      : null,
  };
};

export async function loadOrder(db: PrismaClient, orderId: string, userId: string): Promise<OrderWithRelations> {
  const order = await db.order.findUnique({ where: { id: orderId }, include: ORDER_RELATIONS });
  // Another trader's order id reads as not found: an order id is not a public handle.
  if (!order || order.userId !== userId) throw notFound('no such order');
  return order;
}
