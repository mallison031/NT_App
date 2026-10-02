// D5: every POST that creates money or status has an Idempotency-Key, and the key is bound to
// what was asked for. Two different bodies under one key is a client bug that must be refused,
// not executed twice; one body retried must get the first answer back without a second gateway
// call.
//
// The record is the cache. It is *not* the last word on safety: Order.idempotencyKey,
// Order.quoteId, Payment(provider, providerRef) and WebhookEvent(provider, eventId) are unique
// in the database, so a lost or expired record still cannot create a second order.

import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { IDEMPOTENCY_RETENTION_MS } from '@nt/shared';
import { AppError, conflict, invalidRequest } from '../errors';
import { isUniqueViolation } from '../../db';

/** What the API hands back for a replayed key: the exact status and body of the first run. */
export type StoredResponse = { status: number; body: unknown };

export type IdempotencyScope = {
  key: string;
  userId: string;
  /** The route is part of the hash so one key cannot be replayed against another endpoint. */
  route: string;
  body: unknown;
};

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * A key the client chose is not trusted input: a 2 KB blob or a string with spaces would be
 * stored verbatim as a primary key. Format-check it first and answer with a code the client can
 * act on, rather than letting Postgres produce a 500.
 */
export function readIdempotencyKey(header: string | undefined): string {
  if (header === undefined || header.trim() === '') {
    throw new AppError(
      'missing_idempotency_key',
      400,
      'this request creates state and requires an Idempotency-Key header',
    );
  }
  const key = header.trim();
  if (!KEY_PATTERN.test(key)) {
    throw invalidRequest('Idempotency-Key must be 8 to 128 characters of letters, digits, dash or underscore');
  }
  return key;
}

const canonicalize = (value: unknown): unknown => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((field) => [field, canonicalize(record[field])]),
  );
};

export function requestHashOf(scope: IdempotencyScope): string {
  const material = JSON.stringify({ userId: scope.userId, route: scope.route, body: canonicalize(scope.body) });
  return createHash('sha256').update(material).digest('hex');
}

const isExpired = (storedAt: Date, now: Date): boolean => now.getTime() - storedAt.getTime() > IDEMPOTENCY_RETENTION_MS;

type ExistingRecord = { requestHash: string; response: unknown; createdAt: Date } | null;

export async function requestIdempotently(
  prisma: PrismaClient,
  scope: IdempotencyScope,
  now: () => Date,
  execute: () => Promise<StoredResponse>,
): Promise<StoredResponse> {
  const hash = requestHashOf(scope);
  const current = now();
  const stored = await prisma.idempotencyRecord.findUnique({ where: { key: scope.key } });

  const replay = await decideReplay(prisma, scope.key, hash, stored, current);
  if (replay) return replay;

  const result = await execute();
  // Only a finished answer is stored. A 4xx or 5xx means the caller may legitimately retry the
  // same key after fixing something, and caching the failure would freeze that retry out.
  if (result.status < 400) {
    await prisma.idempotencyRecord.update({
      where: { key: scope.key },
      data: { response: result as Prisma.InputJsonValue },
    });
  }
  return result;
}

async function decideReplay(
  prisma: PrismaClient,
  key: string,
  hash: string,
  existing: ExistingRecord,
  current: Date,
): Promise<StoredResponse | null> {
  if (existing) return verdict(existing, hash, current);

  try {
    await prisma.idempotencyRecord.create({ data: { key, requestHash: hash } });
    return null;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Another request with the same key is in flight. The unique constraints on the domain
    // tables decide who owns the operation; this read only decides what to show the loser.
    const raced = await prisma.idempotencyRecord.findUnique({ where: { key } });
    if (!raced) return null;
    return verdict(raced, hash, current);
  }
}

function verdict(
  record: { requestHash: string; response: unknown; createdAt: Date },
  hash: string,
  current: Date,
): StoredResponse | null {
  if (record.requestHash !== hash) {
    throw conflict('idempotency_conflict', 'this Idempotency-Key was already used for a different request');
  }
  // A stored answer past the retention window is not an answer any more (D5 says 24 hours).
  // Re-running is safe: the domain constraints still refuse a second order for the same key.
  if (record.response === null || isExpired(record.createdAt, current)) return null;
  return record.response as StoredResponse;
}
