// FakePayments (D5, D13f, D13g): stands in for the payment processor. It signs webhooks the
// way a provider does, re-delivers and re-orders them, and can lose the answer to a charge
// creation *after* creating it — because those are the behaviours that break a money path, and
// a fake that only ever succeeds proves nothing.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  isKoboString,
  koboFromString,
  type Kobo,
  koboToString,
  PaymentStatus,
  UtcIsoString,
} from '@nt/shared';
import { mapExternalEnum, type EnumMapping, type UnmappedValue } from '../normalize';
import type {
  Charge,
  ChargeEvent,
  ChargeReq,
  GatewayError,
  PaymentsGateway,
  Result,
  Sourced,
  WebhookInput,
} from '../types';
import {
  beforeCall,
  failure,
  type FakeOptions,
  type QueuedFault,
  resolveOptions,
  rollFailure,
  succeed,
} from './shared';

const SOURCE = 'fake_payments';
const PROVIDER = 'fake';
const SIGNATURE_HEADER = 'x-fake-signature';

/**
 * A locally generated constant for a test double, not a credential. Hard rule 7: no real
 * secret ever appears in code, and this value never leaves the process.
 */
const FAKE_WEBHOOK_SECRET = 'fake-webhook-secret-not-a-real-key';

const PAYMENT_STATUS_TABLE: EnumMapping<PaymentStatus> = {
  pending: 'INITIATED',
  completed: 'SUCCEEDED',
  failed: 'FAILED',
  refunded: 'REFUNDED',
};

/**
 * The fake provider's webhook shape. Real providers put the event id in the payload, so it
 * travels here too: (provider, eventId) dedupe (D5) has to be provable from the body alone.
 * VERIFY: the processor named in the Phase 6 spike will replace this whole schema.
 */
const WebhookBodySchema = z.object({
  id: z.string().min(1),
  event: z.string().min(1),
  data: z.object({
    id: z.string().min(1),
    reference: z.string().min(1),
    amount: z.string().refine(isKoboString, 'amount is not a decimal naira string'),
    status: z.string().min(1),
    createdAt: UtcIsoString,
  }),
});

type DeliveredWebhook = { body: string; eventId: string };

export class FakePayments implements PaymentsGateway {
  readonly #resolved: ReturnType<typeof resolveOptions>;
  readonly #charges = new Map<string, Charge>();
  readonly #chargesByReference = new Map<string, Charge>();
  readonly #referenceByCharge = new Map<string, string>();
  readonly #delivered = new Map<string, DeliveredWebhook[]>();
  #nextCharge = 1;
  #nextEvent = 1;
  #initCharges = 0;
  #duplicateDeliveries = 0;
  #outOfOrderDeliveries = 0;

  public constructor(options: FakeOptions = {}) {
    this.#resolved = resolveOptions(options);
  }

  public get calls(): readonly string[] {
    return this.#resolved.calls;
  }

  public get unmapped(): readonly UnmappedValue[] {
    return this.#resolved.unmapped;
  }

  /** Charges the processor actually created, which a lost response must not inflate. */
  public get initCharges(): number {
    return this.#initCharges;
  }

  public get duplicateDeliveries(): number {
    return this.#duplicateDeliveries;
  }

  public get outOfOrderDeliveries(): number {
    return this.#outOfOrderDeliveries;
  }

  public forceNext(kind: QueuedFault['kind'], detail = 'forced by test', ref?: string): void {
    this.#resolved.queue.push({ kind, detail, ref });
  }

  // ---- PaymentsGateway -------------------------------------------------------------------

  public async initCharge(req: ChargeReq): Promise<Result<Sourced<Charge>, GatewayError>> {
    const gate = await this.#gate(`initCharge:${req.idempotencyKey}`);

    // Same reference, same charge: this is what makes a retried "pay now" harmless.
    const replayed = this.#chargesByReference.get(req.idempotencyKey);
    if (replayed) return succeed({ ...replayed }, this.#asOf(), SOURCE);

    if (gate) {
      if (gate.kind === 'unknown_outcome') {
        // Timeout after the charge was created is the dangerous one: money may really be
        // moving, so the caller gets a handle to confirm with, never a retry licence (D13c).
        const charge = this.#createCharge(req);
        return failure('unknown_outcome', gate.detail, charge.providerRef);
      }
      return failure(gate.kind, gate.detail, gate.ref);
    }

    if (this.#resolved.faults.roll('transientBps')) {
      return failure('transient', `charge for ${req.orderId} refused before it was created`);
    }
    if (this.#resolved.faults.roll('unknownOutcomeBps')) {
      const charge = this.#createCharge(req);
      return failure('unknown_outcome', 'timed out after the charge was created', charge.providerRef);
    }

    return succeed({ ...this.#createCharge(req) }, this.#asOf(), SOURCE);
  }

  public async getCharge(providerRef: string): Promise<Result<Sourced<Charge>, GatewayError>> {
    const gate = await this.#gate(`getCharge:${providerRef}`);
    if (gate) return failure(gate.kind, gate.detail, gate.ref);

    const charge = this.#charges.get(providerRef);
    if (!charge) return failure('permanent', `unknown charge ${providerRef}`);
    // D13f: this is the call a webhook must trigger before anything is fulfilled.
    return succeed({ ...charge }, this.#asOf(), SOURCE);
  }

  public async verifyWebhook(input: WebhookInput): Promise<Result<Sourced<ChargeEvent>, GatewayError>> {
    // No fault gate: signature checking is local work, not a network call. The network half of
    // webhook handling is the getCharge confirmation the caller still has to make.
    const signature = input.headers[SIGNATURE_HEADER];
    if (signature === undefined) return failure('permanent', 'missing signature header');
    if (!this.#signatureMatches(input.rawBody, signature)) {
      return failure('permanent', 'signature verification failed');
    }

    let json: unknown;
    try {
      json = JSON.parse(input.rawBody);
    } catch {
      return failure('permanent', 'webhook body is not JSON');
    }

    const parsed = WebhookBodySchema.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
      return failure('permanent', `unrecognised webhook shape: ${issues}`);
    }
    const body = parsed.data;

    const status = mapExternalEnum({
      raw: body.data.status,
      table: PAYMENT_STATUS_TABLE,
      unknownValue: PaymentStatus.Unknown,
      gateway: SOURCE,
      field: 'status',
      onUnmapped: this.#resolved.reportUnmapped,
    });

    const charge = this.#charges.get(body.data.id);
    return succeed(
      {
        provider: PROVIDER,
        eventId: body.id,
        providerRef: body.data.id,
        amountKobo: koboFromString(body.data.amount),
        status,
      },
      new Date(body.data.createdAt),
      SOURCE,
      // A status we have never seen, or a charge we cannot match, is not a whole event: the
      // caller must hold rather than act (D13b, D13e).
      charge !== undefined && status !== PaymentStatus.Unknown && !this.#resolved.faults.roll('incompleteBps'),
    );
  }

  // ---- provider-side helpers (what the tests drive) ---------------------------------------

  /**
   * Produce a signed webhook for a charge, as the provider would POST it. With faults armed it
   * hands back an event already delivered (duplicate) or an older one (out-of-order) instead of
   * a fresh one, which is the whole point of the fake.
   */
  public webhookFor(providerRef: string, status: string): WebhookInput {
    const charge = this.#charges.get(providerRef);
    if (charge === undefined) throw new Error(`cannot emit a webhook for unknown charge ${providerRef}`);

    const history = this.#delivered.get(providerRef) ?? [];
    const replay = this.#replayFor(history);
    if (replay !== undefined) return this.#sign(replay.body);

    const eventId = `evt-${this.#nextEvent++}`;
    const body = JSON.stringify({
      id: eventId,
      event: `charge.${status}`,
      data: {
        id: providerRef,
        reference: this.#referenceByCharge.get(providerRef) ?? providerRef,
        amount: koboToString(charge.amountKobo),
        status,
        createdAt: this.#asOf().toISOString(),
      },
    });
    history.push({ body, eventId });
    this.#delivered.set(providerRef, history);

    // Sending a webhook moves the provider's own record, so a later getCharge confirms it.
    const mapped = mapExternalEnum({
      raw: status,
      table: PAYMENT_STATUS_TABLE,
      unknownValue: PaymentStatus.Unknown,
      gateway: SOURCE,
      field: 'status',
      onUnmapped: this.#resolved.reportUnmapped,
    });
    charge.status = mapped;
    if (mapped === PaymentStatus.Succeeded) charge.paidAt = this.#resolved.clock();

    return this.#sign(body);
  }

  /** The signature a valid delivery carries, exposed so a test can tamper with it. */
  public signatureFor(body: string): string {
    return createHmac('sha256', FAKE_WEBHOOK_SECRET).update(body).digest('hex');
  }

  /** Wrap an arbitrary body with a valid signature, for malformed-payload cases. */
  public signAsProvider(body: string): WebhookInput {
    return this.#sign(body);
  }

  /** The amount the provider holds for a charge, for the D13f mismatch check. */
  public chargeAmount(providerRef: string): Kobo | undefined {
    return this.#charges.get(providerRef)?.amountKobo;
  }

  // ---- internals -------------------------------------------------------------------------

  #createCharge(req: ChargeReq): Charge {
    const existing = this.#chargesByReference.get(req.idempotencyKey);
    if (existing) return existing;

    const charge: Charge = {
      provider: PROVIDER,
      providerRef: `chg_${this.#nextCharge++}`,
      amountKobo: req.amountKobo,
      status: PaymentStatus.Initiated,
      paidAt: null,
    };
    this.#charges.set(charge.providerRef, charge);
    this.#chargesByReference.set(req.idempotencyKey, charge);
    this.#referenceByCharge.set(charge.providerRef, req.idempotencyKey);
    this.#initCharges += 1;
    return charge;
  }

  #replayFor(history: readonly DeliveredWebhook[]): DeliveredWebhook | undefined {
    if (history.length === 0) return undefined;
    const oldest = history[0];
    const newest = history.at(-1);
    if (oldest === undefined || newest === undefined) return undefined;
    // Out-of-order is checked first: it is the harder case to get right, and an older event
    // would otherwise read as a plain duplicate.
    if (history.length > 1 && this.#resolved.faults.roll('outOfOrderBps')) {
      this.#outOfOrderDeliveries += 1;
      return oldest;
    }
    if (this.#resolved.faults.roll('duplicateEventBps')) {
      this.#duplicateDeliveries += 1;
      return newest;
    }
    return undefined;
  }

  #sign(body: string): WebhookInput {
    return {
      rawBody: body,
      headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: this.signatureFor(body) },
    };
  }

  #signatureMatches(body: string, provided: string): boolean {
    const expected = Buffer.from(this.signatureFor(body), 'utf8');
    const received = Buffer.from(provided, 'utf8');
    if (expected.length !== received.length) return false;
    return timingSafeEqual(expected, received);
  }

  async #gate(operation: string): Promise<{ kind: GatewayError; detail: string; ref?: string } | null> {
    const { fault } = await beforeCall(this.#resolved, operation);
    if (fault) {
      return fault.kind === 'ok'
        ? null
        : { kind: fault.kind, detail: fault.detail ?? 'forced by test', ref: fault.ref };
    }
    const automatic = rollFailure(this.#resolved.faults);
    return automatic ? { kind: automatic, detail: `${operation}: injected fault` } : null;
  }

  #asOf(): Date {
    return this.#resolved.faults.asOf(this.#resolved.clock());
  }
}
