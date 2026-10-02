// The purchase path's HTTP surface. Nothing in this file decides anything: each route parses its
// bytes, calls a module, and hands the module's answer back. That is what makes the money rules
// testable without a server and keeps a transport concern out of a transaction boundary.
//
// Authentication is D9's delegation, not a session of our own: every request that touches a
// trader's own data carries a bearer token which the identity gateway verifies.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CreateOrderRequestSchema, CreateQuoteRequestSchema } from '@nt/shared';
import type { Gateways } from '../gateways/registry';
import type { Env } from '../config/env';
import type { PrismaClient } from '@prisma/client';
import { identifyCaller } from '../modules/auth/identify';
import { readIdempotencyKey, requestIdempotently } from '../modules/idempotency/store';
import { listOffers } from '../modules/catalog/service';
import { createQuote, getQuote } from '../modules/quotes/service';
import { loadOrder, orderToJson } from '../modules/orders/view';
import { placeOrder, type OrderDeps } from '../modules/orders/create';
import { receivePaymentWebhook, type WebhookDeps } from '../modules/payments/webhook';
import { parseJsonBody, headerValue, webhookInputOf } from './payload';

export type HttpDeps = {
  env: Env;
  prisma: PrismaClient;
  gateways: Gateways;
  clock: () => Date;
};

/** The webhook module's dependencies, built once so the dev surface drives the real handler. */
export const webhookDepsOf = (deps: HttpDeps): WebhookDeps => ({
  prisma: deps.prisma,
  tradingPlatform: deps.gateways.tradingPlatform,
  payments: deps.gateways.payments,
  clock: deps.clock,
});

export function registerPurchaseRoutes(app: FastifyInstance, deps: HttpDeps): void {
  const { prisma, gateways, clock } = deps;
  const orderDeps: OrderDeps = {
    prisma,
    payments: gateways.payments,
    paymentsProvider: deps.env.PAYMENTS_PROVIDER,
    clock,
  };
  const webhookDeps = webhookDepsOf(deps);

  const authenticate = async (request: FastifyRequest): Promise<void> => {
    request.caller = await identifyCaller(
      { prisma, identity: gateways.identity },
      request.headers.authorization,
    );
  };
  const authed = { preHandler: [authenticate] };

  // Public: an offer is a price and a rule set, and neither belongs to a trader. It is the only
  // route here that reads no user row.
  app.get('/v1/catalog', async (request) => {
    const { offers, complete, unreadable } = await listOffers(prisma, clock());
    if (unreadable.length > 0) request.log.warn({ withheld: unreadable }, 'catalog offers withheld by an unreadable rule row');
    return { offers, complete };
  });

  // A quote locks a price for fifteen minutes. It is not an order, a payout or a reset, so hard
  // rule 3 does not ask for an Idempotency-Key here: a retried quote request costs a second quote
  // row that expires unused, and cannot move money.
  app.post('/v1/quotes', authed, async (request, reply) => {
    const body = parseJsonBody(CreateQuoteRequestSchema, request.body);
    const quote = await createQuote(prisma, request.caller.userId, body.productVersionId, clock());
    return reply.status(201).send(quote);
  });

  app.get<{ Params: { quoteId: string } }>('/v1/quotes/:quoteId', authed, async (request) => {
    return getQuote(prisma, request.params.quoteId, request.caller.userId);
  });

  app.post('/v1/orders', authed, async (request, reply: FastifyReply) => {
    const body = parseJsonBody(CreateOrderRequestSchema, request.body);
    const key = readIdempotencyKey(headerValue(request.headers['idempotency-key']));
    const outcome = await requestIdempotently(
      prisma,
      { key, userId: request.caller.userId, route: 'POST /v1/orders', body },
      clock,
      () =>
        placeOrder(orderDeps, {
          userId: request.caller.userId,
          idempotencyKey: key,
          quoteId: body.quoteId,
          affiliateRefCode: body.affiliateRefCode,
        }),
    );
    return reply.status(outcome.status).send(outcome.body);
  });

  app.get<{ Params: { orderId: string } }>('/v1/orders/:orderId', authed, async (request) => {
    return orderToJson(await loadOrder(prisma, request.params.orderId, request.caller.userId));
  });

  // No auth: the proof of delivery is the signature over the bytes, which the gateway verifies.
  app.post('/v1/webhooks/payments', async (request) => {
    const effect = await receivePaymentWebhook(webhookDeps, webhookInputOf(request));
    // 200 for a refusal the processor should stop retrying, and for an event that was already
    // processed. Anything recoverable throws, so the sender retries (D13c).
    return { received: true, effect };
  });
}
