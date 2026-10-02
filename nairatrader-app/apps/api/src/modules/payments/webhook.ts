// Hard rule 4 and D13f, end to end: verify the bytes, dedupe by (provider, eventId), then *ask the
// processor* what the charge's state is and believe that answer rather than the notification. A
// webhook is a cue to look, never proof of payment.
//
// Transaction boundary: one transaction does the confirmation write, the order transition and the
// audit rows, with the order locked `FOR UPDATE` so a duplicate delivery running concurrently sees
// a state that has already moved (D5). The gateway calls stay outside it — a processor round trip
// must not be held inside a row lock. Provisioning is then driven after the commit, because a
// ticket can outlive this request.
//
// The notification's own status is never used to decide anything; the confirmed charge is. That is
// what makes an out-of-order or replayed delivery harmless rather than merely unusual.

import type { Prisma } from '@prisma/client';
import { koboToString, ORDER_STATUSES, OrderStatus, PaymentStatus } from '@nt/shared';
import type { Charge, GatewayError, PaymentsGateway, WebhookInput } from '../../gateways/types';
import { AppError, gatewayTransient, gatewayUnavailable, invalidRequest } from '../errors';
import { isUniqueViolation } from '../../db';
import { recordAudit } from '../audit';
import { ORDER_RELATIONS } from '../orders/view';
import { assertTransition } from '../orders/state';
import { advanceFulfilment, type FulfilmentDeps } from '../orders/fulfilment';

export type WebhookDeps = FulfilmentDeps & { payments: PaymentsGateway };

export type WebhookEffect = 'paid' | 'declined' | 'amount_mismatch' | 'unmatched' | 'held' | 'duplicate' | 'refunded';

/** Exported because the reconcile pass confirms a charge with no delivery in hand. */
export type ReceivedEvent = { id: string; provider: string; eventId: string; processedAt: Date | null };

export async function receivePaymentWebhook(deps: WebhookDeps, input: WebhookInput): Promise<WebhookEffect> {
  const verified = await deps.payments.verifyWebhook(input);
  if (!verified.ok) {
    // Refused before anything is written: an unverifiable body is not an event (hard rule 4), and
    // answering 200 here would teach the sender to stop retrying its real ones.
    throw invalidRequest('this webhook was not accepted', `${verified.error}: ${verified.detail ?? 'no detail'}`);
  }
  const event = verified.value.data;
  if (!verified.value.complete) {
    // D13b: half an event may not be acted on, and may not be marked done either. The sender
    // retries, and a later delivery of the same event id can still be completed in full.
    throw gatewayUnavailable('the webhook payload was not complete', `event ${event.eventId}`);
  }

  const stored = await recordEvent(deps, input, event);
  if (stored.processedAt !== null) return 'duplicate';

  const confirmed = await deps.payments.getCharge(event.providerRef);
  if (!confirmed.ok) return deferConfirmation(deps, stored, confirmed.error, confirmed.detail);
  if (!confirmed.value.complete) {
    return deferConfirmation(deps, stored, 'transient', 'the processor answer was incomplete');
  }

  const outcome = await confirmCharge(deps, confirmed.value.data, stored);
  if (outcome.effect === 'paid' && outcome.orderId !== null) await advanceFulfilment(deps, outcome.orderId);
  return outcome.effect;
}

/**
 * The event is recorded before it is understood, because the unique (provider, eventId) index is
 * what makes "processed exactly once" checkable. A retry of an event that was seen but not
 * processed re-enters below and is completed; a retry of one already processed stops here.
 */
async function recordEvent(
  deps: WebhookDeps,
  input: WebhookInput,
  event: { provider: string; eventId: string },
): Promise<ReceivedEvent> {
  const data = { provider: event.provider, eventId: event.eventId, payload: parsePayload(input.rawBody) };
  try {
    return await deps.prisma.webhookEvent.create({ data, select: EVENT_FIELDS });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const seen = await deps.prisma.webhookEvent.findUnique({
      where: { provider_eventId: { provider: event.provider, eventId: event.eventId } },
      select: EVENT_FIELDS,
    });
    if (!seen) throw error;
    return seen;
  }
}

const EVENT_FIELDS = { id: true, provider: true, eventId: true, processedAt: true } as const;

/** The bytes are already verified, so re-parsing them for storage cannot smuggle anything in. */
function parsePayload(rawBody: string): Prisma.InputJsonValue {
  try {
    return JSON.parse(rawBody) as Prisma.InputJsonValue;
  } catch {
    return { unparseable: true };
  }
}

/**
 * The processor could not confirm the charge. The event stays unprocessed so a retry can complete
 * it, and the response says whether a retry is worth doing (D13c).
 */
async function deferConfirmation(
  deps: WebhookDeps,
  event: ReceivedEvent,
  error: GatewayError,
  detail: string | undefined,
): Promise<WebhookEffect> {
  if (error !== 'permanent') {
    await recordAudit(deps.prisma, {
      actor: 'system',
      action: 'webhook.unconfirmed',
      entity: 'WebhookEvent',
      entityId: event.id,
      after: { error, reason: detail ?? 'no detail' },
    });
    throw error === 'unsupported'
      ? gatewayUnavailable('this processor build cannot confirm charges', detail)
      : gatewayTransient('the payment provider is briefly unavailable', detail);
  }

  // permanent: the processor does not know this charge. Nothing to apply, and nothing a retry
  // could improve, so the event closes with a written reason.
  await deps.prisma.$transaction(async (tx) => {
    await markProcessed(tx, event.id, deps.clock());
    await recordAudit(tx, {
      actor: 'system',
      action: 'webhook.unmatched',
      entity: 'WebhookEvent',
      entityId: event.id,
      after: { reason: detail ?? 'the processor does not know this charge' },
    });
  });
  return 'unmatched';
}

type Confirmation = { effect: WebhookEffect; orderId: string | null };

/**
 * One transaction, one lock, one decision, applied to the payment row the charge belongs to.
 *
 * `event` is null when the confirmation was started by the reconcile pass rather than by a
 * delivery: the decision is identical, and the only difference is that there is no event to close.
 */
export async function confirmCharge(
  deps: WebhookDeps,
  charge: Charge,
  event: ReceivedEvent | null,
): Promise<Confirmation> {
  const effect = await deps.prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({
      where: { provider_providerRef: { provider: charge.provider, providerRef: charge.providerRef } },
      include: { order: { include: ORDER_RELATIONS } },
    });
    if (!payment) {
      // A charge no payment row claims. With a delivery in hand the event is closed and written
      // down; when the reconcile pass asked the same question, its own report is the record.
      if (event) {
        await markProcessed(tx, event.id, deps.clock());
        await recordAudit(tx, {
          actor: 'system',
          action: 'webhook.unmatched',
          entity: 'WebhookEvent',
          entityId: event.id,
          after: { reason: `no payment row for ${charge.provider}/${charge.providerRef}` },
        });
      }
      return { effect: 'unmatched' as WebhookEffect, orderId: null };
    }

    const order = payment.order;
    // The lock is taken after the read, so a concurrent delivery of the same event either waits
    // here or finds the state this one is about to write (D5).
    const from = await lockOrderStatus(tx, order.id);
    const target = decide(order.quote.amountKobo, charge, from);

    await tx.payment.update({ where: { id: payment.id }, data: { status: target.paymentStatus } });
    if (target.nextOrderStatus !== null) {
      assertTransition(from, target.nextOrderStatus);
      await tx.order.update({ where: { id: order.id }, data: { status: target.nextOrderStatus } });
    }
    // An event that ended in a hold stays unprocessed: the same delivery can finish the job once
    // the unmapped value is understood, and re-processing one that already moved is a no-op.
    if (target.effect !== 'held' && event) await markProcessed(tx, event.id, deps.clock());

    await recordAudit(tx, {
      actor: 'system',
      action: `payment.${target.effect}`,
      entity: 'Order',
      entityId: order.id,
      before: { status: from },
      after: {
        status: target.nextOrderStatus ?? from,
        paymentStatus: target.paymentStatus,
        amountKobo: koboToString(charge.amountKobo),
        reason: target.reason,
        webhookEventId: event?.id ?? null,
      },
    });
    return { effect: target.effect, orderId: order.id };
  });
  return effect;
}

type Decision = {
  effect: WebhookEffect;
  /** The status to store on the order, or null to leave it where the lock found it. */
  nextOrderStatus: OrderStatus | null;
  paymentStatus: PaymentStatus;
  reason: string;
};

/**
 * A confirmed charge writes PAID and nothing more. Becoming FULFILLING is the fulfilment path's
 * move to make, at the moment it actually asks the platform for an account (D7: a status means the
 * thing its name says). It also means a crash between the two leaves a state the reconcile pass
 * scans, rather than a paid order no one is working on.
 */
function decide(quotedAmountKobo: bigint, charge: Charge, from: OrderStatus): Decision {
  if (charge.amountKobo !== quotedAmountKobo) {
    return {
      effect: 'amount_mismatch',
      nextOrderStatus: null,
      paymentStatus: PaymentStatus.AmountMismatch,
      reason: `quoted ${koboToString(quotedAmountKobo)}, charged ${koboToString(charge.amountKobo)}`,
    };
  }

  switch (charge.status) {
    case PaymentStatus.Succeeded:
      if (from === OrderStatus.Paid || from === OrderStatus.Fulfilling || from === OrderStatus.Fulfilled) {
        // Already moved by an earlier confirmation. Nothing to do, and nothing to charge again.
        return { effect: 'held', nextOrderStatus: null, paymentStatus: charge.status, reason: `already ${from}` };
      }
      return {
        effect: 'paid',
        nextOrderStatus: OrderStatus.Paid,
        paymentStatus: charge.status,
        reason: 'charge confirmed at the quoted amount',
      };
    case PaymentStatus.Failed:
      // A declined charge takes no money, so the order may close. Once an order has been paid the
      // same notification is a contradiction rather than a decline, and holding is the only honest
      // answer.
      if (from === OrderStatus.PendingPayment || from === OrderStatus.PendingReconcile) {
        return { effect: 'declined', nextOrderStatus: OrderStatus.Failed, paymentStatus: charge.status, reason: 'charge declined' };
      }
      return { effect: 'held', nextOrderStatus: null, paymentStatus: charge.status, reason: `declined after ${from}` };
    case PaymentStatus.Refunded:
      // Order-level refunds are not built (PRD section 3 leaves money movement with ops in v1), so
      // the payment row tells the truth and the order is left where it is.
      return { effect: 'refunded', nextOrderStatus: null, paymentStatus: charge.status, reason: 'charge refunded' };
    case PaymentStatus.Unknown:
    case PaymentStatus.Initiated:
    case PaymentStatus.AmountMismatch:
      // D13e: an unrecognised or unfinished provider status holds the entity and is written down,
      // rather than defaulting to the status that would make the flow continue.
      return {
        effect: 'held',
        nextOrderStatus: from === OrderStatus.PendingReconcile ? null : OrderStatus.PendingReconcile,
        paymentStatus: PaymentStatus.Unknown,
        reason: `unmapped or unfinished charge status ${charge.status}`,
      };
  }
}

/**
 * The lock the decision is taken under. Only the status is read: the amount comes from the quote,
 * and nothing writes a PriceQuote after it is created.
 */
async function lockOrderStatus(tx: Prisma.TransactionClient, orderId: string): Promise<OrderStatus> {
  const rows = await tx.$queryRaw<{ status: string }[]>`
    SELECT status FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
  const row = rows[0];
  if (!row) throw new AppError('not_found', 404, `order ${orderId} disappeared`);
  return asStoredStatus(row.status);
}

/** A stored status this build cannot name is schema drift, not something to guess at (D13e). */
function asStoredStatus(value: string): OrderStatus {
  if (!ORDER_STATUSES.includes(value as OrderStatus)) {
    throw new AppError('gateway_unavailable', 500, `unknown stored order status ${value}`);
  }
  return value as OrderStatus;
}

const markProcessed = (tx: Prisma.TransactionClient, eventId: string, at: Date): Promise<unknown> =>
  tx.webhookEvent.update({ where: { id: eventId }, data: { processedAt: at } });
