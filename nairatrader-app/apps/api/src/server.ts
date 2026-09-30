import Fastify from 'fastify';
import { loadEnv } from './config/env';

const env = loadEnv();

export const app = Fastify({ logger: env.NODE_ENV !== 'test' });

app.get('/healthz', async () => ({
  ok: true,
  gateways: {
    trading: env.TRADING_GATEWAY,
    identity: env.IDENTITY_GATEWAY,
    payments: env.PAYMENTS_PROVIDER,
  },
}));

if (import.meta.url === `file://${process.argv[1]}`) {
  const address = await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(`api listening on ${address}`);
}
