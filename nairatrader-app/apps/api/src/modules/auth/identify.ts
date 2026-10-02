// D9: identity lives upstream. This module does one thing — turn a bearer token into a local
// user row — and issues no tokens of its own. The access/refresh session D9 describes is a
// later slice (the phase plan defers rotating refresh tokens), and until then every request is
// verified against the identity gateway, which is the same authority a session would inherit.
//
// A token whose verification we cannot read is never treated as a valid one: an unreadable
// identity answer is not an identity answer (D13b, D13c).

import type { PrismaClient } from '@prisma/client';
import type { IdentityGateway } from '../../gateways/types';
import { gatewayTransient, gatewayUnavailable, unauthorized } from '../errors';
import { isUniqueViolation } from '../../db';

export type Authenticated = { userId: string; externalId: string };

export type IdentifyDeps = { prisma: PrismaClient; identity: IdentityGateway };

const bearerToken = (header: string | undefined): string => {
  const [scheme, token] = (header ?? '').trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'bearer' || token === undefined || token === '') {
    throw unauthorized('send an Authorization: Bearer <token> header');
  }
  return token;
};

export async function identifyCaller(
  deps: IdentifyDeps,
  authorizationHeader: string | undefined,
): Promise<Authenticated> {
  const token = bearerToken(authorizationHeader);
  const verified = await deps.identity.verifyToken(token);

  if (!verified.ok) {
    switch (verified.error) {
      case 'transient':
        throw gatewayTransient(
          'the identity system is briefly unavailable',
          `verifyToken: ${verified.detail ?? 'no detail'}`,
        );
      case 'unsupported':
      case 'unknown_outcome':
        // unknown_outcome on a verification still means "we do not know who this is". Retrying
        // is safe for the client, inventing a user is not.
        throw gatewayUnavailable(
          'the identity system did not answer',
          `verifyToken: ${verified.detail ?? 'no detail'}`,
        );
      case 'permanent':
        throw unauthorized('this session is not valid');
    }
  }
  if (!verified.value.complete) {
    throw gatewayUnavailable('the identity answer was incomplete', 'verifyToken returned complete=false');
  }

  const externalId = verified.value.data.userId;
  const existing = await deps.prisma.user.findUnique({ where: { externalId } });
  if (existing) return { userId: existing.id, externalId };

  try {
    const created = await deps.prisma.user.create({ data: { externalId } });
    // Contact details are enriched once, at first sight, rather than on every authenticated
    // request: the profile is the identity system's to hold, and a read per call would make
    // upstream latency part of every dashboard load.
    await enrichFromIdentity(deps, created.id, externalId);
    return { userId: created.id, externalId };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await deps.prisma.user.findUnique({ where: { externalId } });
    if (!raced) throw error;
    return { userId: raced.id, externalId };
  }
}

async function enrichFromIdentity(deps: IdentifyDeps, userId: string, externalId: string): Promise<void> {
  const profile = await deps.identity.getUser(externalId);
  if (!profile.ok || !profile.value.complete) return;
  const { email, phone, displayName } = profile.value.data;
  if (email === null && phone === null && displayName === null) return;
  await deps.prisma.user.update({ where: { id: userId }, data: { email, phone, displayName } });
}
