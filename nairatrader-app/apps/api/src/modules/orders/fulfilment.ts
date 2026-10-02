// D13d applied: provisioning is a ticket, not a response. An order that has been paid reaches
// FULFILLING and stays there until the platform says the account exists, which may take a poll or
// two — and everything in this file is written so it can be run again by the reconcile pass after
// a crash, without the platform doing anything twice.
//
// D1 is the reason this file never writes TradingAccount.status. A resolved ticket hands us a
// login; whether that account is in evaluation, passed or breached is the risk engine's answer and
// arrives through the Account State Contract in Phase 4.

import type { Prisma, PrismaClient } from '@prisma/client';
import { koboFromString, koboToString, type Kobo, OrderStatus } from '@nt/shared';
import type { ProvisionOutcome, TradingPlatformGateway } from '../../gateways/types';
import { AppError } from '../errors';
import { recordAudit } from '../audit';
import { ORDER_RELATIONS, type OrderWithRelations } from './view';
import { assertTransition } from './state';

export type FulfilmentDeps = {
  prisma: PrismaClient;
  tradingPlatform: TradingPlatformGateway;
  clock: () => Date;
};

/** Lets a helper take either the client or an open transaction without duplicating its body. */
type Transaction = Prisma.TransactionClient;

/** One key for one order's provisioning, forever: the platform dedupes on it (D13c). */
const provisionKeyOf = (orderId: string): string => `order:${orderId}:provision`;

type SnapshotRules = { accountSizeKobo?: string; productVersionId?: string };

/**
 * The account size the trader bought, read from the frozen rule snapshot rather than from the
 * catalog: if the product changed while provisioning was open, provisioning must still deliver
 * what was purchased (D3).
 */
function purchasedSize(order: OrderWithRelations): { accountSizeKobo: Kobo; productVersionId: string } {
  const account = order.account;
  if (!account) throw new AppError('invalid_request', 500, 'this order has no account to provision');
  const rules = (account.ruleSnapshot?.rules ?? {}) as SnapshotRules;
  if (typeof rules.accountSizeKobo !== 'string' || rules.productVersionId === undefined) {
    throw new AppError('invalid_request', 500, 'the rule snapshot on this order is missing its size');
  }
  return {
    accountSizeKobo: koboFromString(rules.accountSizeKobo),
    productVersionId: account.ruleSnapshot?.versionId ?? rules.productVersionId,
  };
}

/**
 * Move a paid order forward: become FULFILLING, then ask for provisioning if we never asked,
 * otherwise poll the ticket we hold. Safe to call repeatedly — which is exactly why it exists as
 * its own function rather than living inside the webhook handler.
 */
export async function advanceFulfilment(deps: FulfilmentDeps, orderId: string): Promise<void> {
  const order = await deps.prisma.order.findUnique({ where: { id: orderId }, include: ORDER_RELATIONS });
  if (!order) return;
  if (order.status !== OrderStatus.Fulfilling && order.status !== OrderStatus.Paid) return;

  // The status changes when provisioning starts, not when the money lands: PENDING_PAYMENT -> PAID
  // is the confirmation's move, PAID -> FULFILLING is this one (D7).
  const inFlight = order.status === OrderStatus.Paid ? await beginFulfilment(deps, order) : order;

  if (inFlight.provisionTicketId === null) {
    await requestProvisioning(deps, inFlight);
    return;
  }
  await pollProvisionTicket(deps, inFlight, inFlight.provisionTicketId);
}

async function beginFulfilment(deps: FulfilmentDeps, order: OrderWithRelations): Promise<OrderWithRelations> {
  await move(deps, order, OrderStatus.Fulfilling);
  return { ...order, status: OrderStatus.Fulfilling };
}

async function requestProvisioning(deps: FulfilmentDeps, order: OrderWithRelations): Promise<void> {
  const { accountSizeKobo, productVersionId } = purchasedSize(order);
  const result = await deps.tradingPlatform.requestProvision({
    idempotencyKey: provisionKeyOf(order.id),
    userId: order.userId,
    productVersionId,
    accountSizeKobo,
    platform: 'mt5',
  });

  if (result.ok) {
    await deps.prisma.order.update({
      where: { id: order.id },
      data: { provisionTicketId: result.value.data.id },
    });
    await recordAudit(deps.prisma, {
      actor: 'system',
      action: 'provision.requested',
      entity: 'Order',
      entityId: order.id,
      after: { ticketId: result.value.data.id, accountSizeKobo: koboToString(accountSizeKobo) },
    });
    // The same call polls immediately: a platform that provisions synchronously should not make
    // the trader wait for the next reconcile pass to see a login.
    await pollProvisionTicket(deps, order, result.value.data.id);
    return;
  }

  switch (result.error) {
    case 'transient':
      // Nothing was asked, nothing was written. FULFILLING is the correct place to sit and wait.
      await recordAudit(deps.prisma, {
        actor: 'system',
        action: 'provision.deferred',
        entity: 'Order',
        entityId: order.id,
        after: { reason: result.detail ?? 'the platform refused before seeing the request' },
      });
      return;
    case 'unsupported':
      // D13c: a capability the platform lacks is feature-off, never a trader-facing error. The
      // order keeps waiting rather than being marked failed for something the platform never offered.
      await recordAudit(deps.prisma, {
        actor: 'system',
        action: 'provision.unsupported',
        entity: 'Order',
        entityId: order.id,
        after: { reason: result.detail ?? 'not supported' },
      });
      return;
    case 'permanent':
    case 'unknown_outcome': {
      // Both hold. Money has been taken, so marking the order FAILED would be this build deciding
      // to keep a paid-for account unprovisioned — that is a refund decision, and refunds are not
      // built (PRD section 3 keeps payouts and refunds with ops in v1).
      const next = holdStatus(order.status);
      if (order.provisionTicketId === null && result.ref !== undefined) {
        await deps.prisma.order.update({
          where: { id: order.id },
          data: { provisionTicketId: result.ref },
        });
      }
      await move(deps, order, next);
      await recordAudit(deps.prisma, {
        actor: 'system',
        action: result.error === 'permanent' ? 'provision.refused' : 'provision.answer_lost',
        entity: 'Order',
        entityId: order.id,
        after: { reason: result.detail ?? 'no detail', heldAs: next, ticketHandle: result.ref ?? null },
      });
    }
  }
}

async function pollProvisionTicket(deps: FulfilmentDeps, order: OrderWithRelations, ticketId: string): Promise<void> {
  const result = await deps.tradingPlatform.getProvision(ticketId);

  if (!result.ok) {
    if (result.error === 'transient') return; // still open as far as we know; poll again later
    await move(deps, order, holdStatus(order.status));
    await recordAudit(deps.prisma, {
      actor: 'system',
      action: 'provision.ticket_unreadable',
      entity: 'Order',
      entityId: order.id,
      after: { ticketId, error: result.error, reason: result.detail ?? 'no detail' },
    });
    return;
  }

  const outcome = result.value.data;
  // D13b: an incomplete read may not close an order, and D13e: an unmapped state may not either.
  if (!result.value.complete || outcome.state === 'UNKNOWN') {
    await recordAudit(deps.prisma, {
      actor: 'system',
      action: 'provision.held',
      entity: 'Order',
      entityId: order.id,
      after: { ticketId, reason: outcome.state === 'UNKNOWN' ? 'unmapped ticket state' : 'incomplete read' },
    });
    return;
  }

  switch (outcome.state) {
    case 'PENDING':
      return; // D13d: the ticket is open; FULFILLING is the honest state to remain in.
    case 'FAILED':
      await move(deps, order, holdStatus(order.status));
      await recordAudit(deps.prisma, {
        actor: 'system',
        action: 'provision.failed',
        entity: 'Order',
        entityId: order.id,
        after: { ticketId },
      });
      return;
    case 'SUCCEEDED':
      await recordProvisionedAccount(deps, order, ticketId, outcome);
      return;
  }
}

/**
 * The only write that closes an order: the login and the credential *handle*. Status is untouched
 * (D1), and the password is never here at all (D11) — a handle is a pointer to something the
 * platform still holds.
 */
async function recordProvisionedAccount(
  deps: FulfilmentDeps,
  order: OrderWithRelations,
  ticketId: string,
  outcome: ProvisionOutcome,
): Promise<void> {
  if (outcome.login === undefined || outcome.credentialHandle === undefined) {
    // A "succeeded" outcome that does not say which account it succeeded with is not a whole
    // answer, and there is no safe guess to make about it.
    await move(deps, order, holdStatus(order.status));
    await recordAudit(deps.prisma, {
      actor: 'system',
      action: 'provision.incomplete_success',
      entity: 'Order',
      entityId: order.id,
      after: { ticketId, login: outcome.login ?? null, credentialHandle: outcome.credentialHandle ?? null },
    });
    return;
  }

  const accountId = order.account?.id;
  if (accountId === undefined) {
    await move(deps, order, holdStatus(order.status));
    await recordAudit(deps.prisma, {
      actor: 'system',
      action: 'provision.no_account',
      entity: 'Order',
      entityId: order.id,
      after: { ticketId },
    });
    return;
  }

  await deps.prisma.$transaction(async (tx) => {
    await tx.tradingAccount.update({
      where: { id: accountId },
      data: { mtLogin: outcome.login, mtCredentialHandle: outcome.credentialHandle, lastSyncedAt: deps.clock() },
    });
    await moveToFulfilled(tx, order);
    await recordAudit(tx, {
      actor: 'system',
      action: 'order.fulfilled',
      entity: 'Order',
      entityId: order.id,
      after: { login: outcome.login, ticketId },
    });
  });
}

/**
 * The closing write re-reads the row it is changing: a webhook and a reconcile pass can be in
 * this order at the same moment, and the transition table must judge the status that is actually
 * stored, not the one loaded before the network call.
 */
async function moveToFulfilled(tx: Transaction, order: OrderWithRelations): Promise<void> {
  const fresh = await tx.order.findUnique({ where: { id: order.id }, select: { status: true } });
  if (!fresh || fresh.status === OrderStatus.Fulfilled) return;
  assertTransition(fresh.status as OrderStatus, OrderStatus.Fulfilled);
  await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.Fulfilled } });
}

/**
 * PENDING_RECONCILE is the only hold this path may choose, and it is chosen rather than FAILED
 * because a paid order that cannot be provisioned is an open question, not a closed one. From
 * PENDING_RECONCILE the reconcile pass can still go anywhere the truth turns out to be.
 */
const holdStatus = (current: OrderStatus): OrderStatus =>
  current === OrderStatus.Fulfilling || current === OrderStatus.Paid ? OrderStatus.PendingReconcile : current;

/** An in-memory status becomes a written one only through the transition table (D7). */
async function move(deps: FulfilmentDeps, order: OrderWithRelations, next: OrderStatus): Promise<void> {
  if (order.status === next) return;
  assertTransition(order.status, next);
  await deps.prisma.order.update({ where: { id: order.id }, data: { status: next } });
}
