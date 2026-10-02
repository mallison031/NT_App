// The process entrypoint. Building the app is separate from starting it, so a test can drive the
// same composition with inject() against a throwaway database.

import { loadEnv } from './config/env';
import { createDb } from './db';
import { buildGateways } from './gateways/registry';
import { buildApp } from './http/app';

const env = loadEnv();
const prisma = createDb(env);
const app = buildApp({ env, prisma, gateways: buildGateways(env), clock: () => new Date() });

if (import.meta.url === `file://${process.argv[1]}`) {
  const address = await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(`api listening on ${address}`);

  // D12: this container is disposable, so stop taking requests and let the in-flight ones finish
  // rather than waiting to be killed.
  const close = async (): Promise<void> => {
    await app.close();
    await prisma.$disconnect();
  };
  process.once('SIGTERM', () => void close());
  process.once('SIGINT', () => void close());
}
