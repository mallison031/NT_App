import { z } from 'zod';

// Names only; values come from the environment. Never add a real credential here.
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).optional(),
  TRADING_GATEWAY: z.enum(['fake', 'mt5']).default('fake'),
  IDENTITY_GATEWAY: z.enum(['fake', 'real']).default('fake'),
  // The three switches choose an *implementation*, so they all default to the Fake gateway:
  // hard rule "when blocked by an unknown, implement against the Fake and stop". The real
  // values name the systems the Phase 6 spike will confirm, and gateways/registry.ts refuses
  // to build them until an adapter exists.
  // VERIFY: owner confirms paystack is the processor; PRD section 5 leaves it open.
  PAYMENTS_PROVIDER: z.enum(['fake', 'paystack']).default('fake'),
  PAYMENTS_SECRET_KEY: z.string().min(1).optional(),
  PAYMENTS_WEBHOOK_SECRET: z.string().min(1).optional(),
  JWT_SECRET: z.string().min(32).optional(),
  KMS_KEY_ID: z.string().min(1).optional(),
  SENTRY_DSN: z.string().url().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return EnvSchema.parse(source);
}

// JWT_SECRET and KMS_KEY_ID are optional only so the fake-gateway dev loop runs;
// the auth and crypto modules make them required when they land.
