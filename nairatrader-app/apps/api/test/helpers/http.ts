// The integration harness: the same composition src/server.ts builds, wired to a throwaway
// Postgres and to fakes a test can arm faults against. Requests go in through Fastify's inject(),
// so what is asserted is the wire — status codes and bodies — not a module's internals.

import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance, InjectOptions } from 'fastify';
import {
  CatalogJsonSchema,
  type CatalogJson,
  OrderJsonSchema,
  type OrderJson,
  QuoteJsonSchema,
  type QuoteJson,
} from '@nt/shared';
import { loadEnv } from '../../src/config/env';
import { buildApp } from '../../src/http/app';
import type { Gateways } from '../../src/gateways/registry';
import { FakeIdentity } from '../../src/gateways/fakes/fake-identity';
import { FakePayments } from '../../src/gateways/fakes/fake-payments';
import { FakeTradingPlatform } from '../../src/gateways/fakes/fake-trading-platform';
import type { WebhookInput } from '../../src/gateways/types';
import type { TestDb } from './postgres';

/** Fixed, so quote expiry and the idempotency window are arithmetic rather than a race. */
export const TEST_START = new Date('2026-04-01T09:00:00Z');

export type MutableClock = { now: () => Date; advance: (ms: number) => void };

/** What a test asserts on: the two things an HTTP client can see. */
export type Reply = { statusCode: number; payload: string };

export type TestApp = {
  app: FastifyInstance;
  prisma: PrismaClient;
  clock: MutableClock;
  fakes: { tradingPlatform: FakeTradingPlatform; identity: FakeIdentity; payments: FakePayments };
};

export function createTestApp(db: TestDb): TestApp {
  let current = TEST_START;
  const clock: MutableClock = {
    now: () => current,
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms);
    },
  };
  const fakes = {
    tradingPlatform: new FakeTradingPlatform({ clock: clock.now }),
    identity: new FakeIdentity({ clock: clock.now }),
    payments: new FakePayments({ clock: clock.now }),
  };
  const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: db.url });
  const app = buildApp({ env, prisma: db.prisma, gateways: fakes satisfies Gateways, clock: clock.now });
  return { app, prisma: db.prisma, clock, fakes };
}

export type Call = { token?: string; key?: string };

const headersOf = (call: Call): Record<string, string> => ({
  ...(call.token === undefined ? {} : { authorization: `Bearer ${call.token}` }),
  ...(call.key === undefined ? {} : { 'idempotency-key': call.key }),
});

async function request(app: FastifyInstance, options: InjectOptions): Promise<Reply> {
  const response = await app.inject(options);
  return { statusCode: response.statusCode, payload: response.payload };
}

export const getJson = (t: TestApp, url: string, call: Call = {}): Promise<Reply> =>
  request(t.app, { method: 'GET', url, headers: headersOf(call) });

export const postJson = (t: TestApp, url: string, body: unknown, call: Call = {}): Promise<Reply> =>
  request(t.app, { method: 'POST', url, payload: body as InjectOptions['payload'], headers: headersOf(call) });

/**
 * Deliver a provider webhook the way the processor would post it. `tamper` corrupts the signed
 * bytes rather than the header, so no test has to know what a processor names its signature.
 */
export const deliverWebhook = (
  t: TestApp,
  delivery: WebhookInput,
  options: { tamper?: boolean } = {},
): Promise<Reply> =>
  request(t.app, {
    method: 'POST',
    url: '/v1/webhooks/payments',
    headers: delivery.headers as Record<string, string>,
    payload: options.tamper === true ? `${delivery.rawBody} ` : delivery.rawBody,
  });

export const jsonOf = <T>(reply: Reply): T => JSON.parse(reply.payload) as T;

/** The error body, which every failure here must be able to render as {code, message}. */
export const codeOf = (reply: Reply): string => jsonOf<{ code: string }>(reply).code;

/** A signed dev session for a placeholder trader, through the same route a browser would use. */
export async function sessionToken(t: TestApp, externalId = 'ext-trader-1'): Promise<string> {
  const reply = await postJson(t, '/v1/dev/session', { externalId });
  if (reply.statusCode !== 201) throw new Error(`dev session refused: ${reply.statusCode} ${reply.payload}`);
  return jsonOf<{ token: string }>(reply).token;
}

/**
 * Read a body through its shared schema. The mobile client is built against those schemas, so a
 * response this cannot parse is a contract break even when the test's own expectations hold.
 */
export const asQuote = (reply: Reply): QuoteJson => QuoteJsonSchema.parse(jsonOf<unknown>(reply));

export const asOrder = (reply: Reply): OrderJson => OrderJsonSchema.parse(jsonOf<unknown>(reply));

export const asCatalog = (reply: Reply): CatalogJson => CatalogJsonSchema.parse(jsonOf<unknown>(reply));

/** The one thing every purchase test asks for: the order, as its owner sees it. */
export async function fetchOrder(t: TestApp, token: string, orderId: string): Promise<OrderJson> {
  const reply = await getJson(t, `/v1/orders/${orderId}`, { token });
  if (reply.statusCode !== 200) throw new Error(`order read failed: ${reply.statusCode} ${reply.payload}`);
  return asOrder(reply);
}

/** The provider reference the processor gave the charge, or a failure that says which step broke. */
export function providerRefOf(order: OrderJson, step: string): string {
  if (order.payment === null) throw new Error(`${step}: the order carries no payment (${order.status})`);
  return order.payment.providerRef;
}

/** Quote a seeded offer and place the order, stopping where the test can take the money forward. */
export async function orderFor(
  t: TestApp,
  token: string,
  productVersionId: string,
  idempotencyKey: string,
): Promise<{ order: OrderJson; quote: QuoteJson }> {
  const quoteReply = await postJson(t, '/v1/quotes', { productVersionId }, { token });
  if (quoteReply.statusCode !== 201) throw new Error(`quote failed: ${quoteReply.statusCode} ${quoteReply.payload}`);
  const quote = asQuote(quoteReply);
  const orderReply = await postJson(t, '/v1/orders', { quoteId: quote.id }, { token, key: idempotencyKey });
  if (orderReply.statusCode !== 201) throw new Error(`order failed: ${orderReply.statusCode} ${orderReply.payload}`);
  return { order: asOrder(orderReply), quote };
}
