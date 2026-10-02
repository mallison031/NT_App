// The composition root: the only file that knows Fastify exists and the only one that decides
// which gateway implementations answer. Everything below it (modules, jobs) takes dependencies,
// so a test can build the same app against fakes and a throwaway database.

import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { ApiErrorJson } from '@nt/shared';
import { AppError } from '../modules/errors';
import type { Authenticated } from '../modules/auth/identify';
import { FakeIdentity } from '../gateways/fakes/fake-identity';
import { FakePayments } from '../gateways/fakes/fake-payments';
import { registerPurchaseRoutes, webhookDepsOf, type HttpDeps } from './routes';
import { registerDevRoutes, type DevSurface } from './dev-routes';
import { rawJsonParser } from './payload';

declare module 'fastify' {
  interface FastifyRequest {
    /** Written by the authenticate preHandler. Public routes never read it. */
    caller: Authenticated;
  }
}

export function buildApp(deps: HttpDeps): FastifyInstance {
  const app = Fastify({ logger: deps.env.NODE_ENV !== 'test' });

  // The bytes reach the handler unparsed, because a webhook signature is verified over them.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, rawJsonParser);

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      // `detail` exists for the operator's log line and is never sent (hard rule 7).
      if (error.detail !== undefined) request.log.warn({ code: error.code, detail: error.detail }, error.message);
      return reply.status(error.status).send({ code: error.code, message: error.message } satisfies ApiErrorJson);
    }
    const status = error.statusCode ?? 0;
    if (status >= 400 && status < 500) {
      return reply.status(status).send({ code: 'invalid_request', message: 'the request could not be read' });
    }
    request.log.error({ err: error }, 'request failed');
    return reply.status(500).send({ code: 'internal_error', message: 'the service could not complete this request' });
  });

  app.get('/healthz', async () => ({
    ok: true,
    gateways: {
      trading: deps.env.TRADING_GATEWAY,
      identity: deps.env.IDENTITY_GATEWAY,
      payments: deps.env.PAYMENTS_PROVIDER,
    },
  }));

  registerPurchaseRoutes(app, deps);
  const surface = devSurfaceOf(deps);
  if (surface) registerDevRoutes(app, webhookDepsOf(deps), surface);
  return app;
}

/**
 * The gate is the implementation, not a flag: `instanceof` is what proves this process is holding
 * fakes, because a real adapter has no token to mint and no webhook to forge. The Fakes are also
 * unreachable in production (config/env.ts defaults and registry.ts refuses real values), so the
 * surface cannot be turned on by an environment variable alone.
 */
function devSurfaceOf(deps: HttpDeps): DevSurface | null {
  if (deps.env.NODE_ENV === 'production') return null;
  const { identity, payments } = deps.gateways;
  return identity instanceof FakeIdentity && payments instanceof FakePayments ? { identity, payments } : null;
}
