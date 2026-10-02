import { Prisma, PrismaClient } from '@prisma/client';
import type { Env } from './config/env';

/**
 * One PrismaClient per process (D12: one API container, one worker container). The URL comes
 * from validated env only, so a test can point a second instance at a throwaway container
 * without touching process.env.
 */
export function createDb(env: Pick<Env, 'DATABASE_URL'>): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
}

/**
 * A unique-constraint violation is the signal that a concurrent duplicate got there first.
 * Every idempotent write path in this app ends up asking the same question, so it is asked
 * once here instead of re-typing the error code at each call site.
 */
export const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
