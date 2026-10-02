// A dev-only control surface, and the reason it exists is observability: the Fake processor signs
// its webhooks with an in-process secret and the reconcile worker is not built yet, so without
// these three routes the purchase path can be started from curl but never finished. Each one
// stands in for something real that a trader's bank, the processor, or the platform would do.
//
// They register only when the identity and payments gateways are the Fakes (see app.ts), and the
// Fakes are only selectable outside production, so no deployment of this app can answer one.
//
// The request schemas are local on purpose: they describe this surface, not the product API, and
// the mobile client must never have to know they exist. Product bodies still come from @nt/shared.

import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { FakeIdentity } from '../gateways/fakes/fake-identity';
import type { FakePayments } from '../gateways/fakes/fake-payments';
import { reconcilePendingOrders } from '../jobs/reconcile-pending';
import { receivePaymentWebhook, type WebhookDeps } from '../modules/payments/webhook';
import { invalidRequest } from '../modules/errors';
import { parseJsonBody } from './payload';

export type DevSurface = { identity: FakeIdentity; payments: FakePayments };

/** Long enough to walk a flow by hand, short enough that a leaked dev token expires on its own. */
const DEV_TOKEN_TTL_MS = 60 * 60 * 1000;

const SessionRequestSchema = z.strictObject({ externalId: z.string().min(1).max(64).optional() });

const DeliveryRequestSchema = z.strictObject({
  providerRef: z.string().min(1).max(64),
  /** The provider's own spelling, so 'completed' and an unseen value both exercise the mapping. */
  status: z.string().min(1).max(32).default('completed'),
});

const ReconcileRequestSchema = z.strictObject({ limit: z.number().int().positive().max(200).optional() });

export function registerDevRoutes(app: FastifyInstance, webhookDeps: WebhookDeps, surface: DevSurface): void {
  app.log.warn('dev-only control surface is enabled: /v1/dev/* mints sessions and fakes provider deliveries');

  /** Stands in for the hosted sign-in page D9 delegates to (Phase 7 owns the real session). */
  app.post('/v1/dev/session', async (request, reply) => {
    const body = parseJsonBody(SessionRequestSchema, request.body);
    const externalId = body.externalId ?? 'dev-trader-1';
    // Placeholder profile only: hard rule 7 keeps real contact data out of code and fixtures.
    surface.identity.seedUser({ userId: externalId, email: null, phone: null, displayName: 'DEV PLACEHOLDER' });
    const token = surface.identity.issueToken(externalId, new Date(webhookDeps.clock().getTime() + DEV_TOKEN_TTL_MS));
    return reply.status(201).send({ token, externalId });
  });

  /** Stands in for the processor POSTing to /v1/webhooks/payments, signed with its own key. */
  app.post('/v1/dev/payments/deliver', async (request) => {
    const body = parseJsonBody(DeliveryRequestSchema, request.body);
    if (surface.payments.chargeAmount(body.providerRef) === undefined) {
      throw invalidRequest('the fake processor holds no charge with that reference');
    }
    const delivery = surface.payments.webhookFor(body.providerRef, body.status);
    const effect = await receivePaymentWebhook(webhookDeps, delivery);
    return { effect };
  });

  /** Stands in for the D12 worker container: runs one pass of the reconcile job, now. */
  app.post('/v1/dev/reconcile', async (request) => {
    const body = parseJsonBody(ReconcileRequestSchema, request.body);
    return reconcilePendingOrders(webhookDeps, body.limit);
  });
}
