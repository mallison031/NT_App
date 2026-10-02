// The shared gateway contract (D13g). These are the behaviours Architecture-Essential says an
// integration must have, written once against a harness instead of once per implementation:
// provenance on every read, four typed failures, unmapped values that hold instead of guess,
// async operations that resolve through a ticket, and a lost response that never turns into a
// second write.
//
// It runs against the Fakes today. When a real adapter exists (Phase 6) the same suite runs
// against it with a harness that arranges these conditions in a sandbox — and a platform that
// cannot arrange them is itself a finding.

import { describe, expect, it } from 'vitest';
import {
  type AccountState,
  type AccountStateWire,
  canDriveStatusTransition,
  isStale,
  type Kobo,
  koboFromString,
} from '@nt/shared';
import { HOSTILE_FAULTS, profileWith } from '../../src/gateways/fault-profile';
import type { ChargeReq, GatewayError, Result, Sourced, Trade } from '../../src/gateways/types';
import type { ContractGateways } from './harness';

type AnyResult<T> = Result<Sourced<T>, GatewayError>;

const FAILURES: readonly GatewayError[] = ['transient', 'permanent', 'unsupported', 'unknown_outcome'];

function accepted<T>(result: AnyResult<T>, what: string): Sourced<T> {
  if (!result.ok) {
    throw new Error(`${what}: expected success, got ${result.error} (${result.detail ?? 'no detail'})`);
  }
  return result.value;
}

function refused<T>(result: AnyResult<T>, what: string): { error: GatewayError; detail?: string; ref?: string } {
  if (result.ok) throw new Error(`${what}: expected refusal, got ${JSON.stringify(result.value)}`);
  return result;
}

function expectProvenance(sourced: Sourced<unknown>): void {
  expect(sourced.asOf, 'asOf must be a Date').toBeInstanceOf(Date);
  expect(typeof sourced.source).toBe('string');
  expect(sourced.source.length, 'source must say where the data came from').toBeGreaterThan(0);
  expect(typeof sourced.complete).toBe('boolean');
}

const trade = (id: string, profitKobo: Kobo): Trade => ({
  platformTradeId: id,
  login: 'unused',
  symbol: 'USDNGN',
  openedAt: new Date('2026-04-01T09:00:00Z'),
  closedAt: new Date('2026-04-01T10:00:00Z'),
  profitKobo,
  lots: '0.10',
});

export function describeGatewayContract(gateways: ContractGateways): void {
  const label = (name: string): string => `${gateways.name} · ${name}`;

  describe(label('TradingPlatformGateway reads'), () => {
    it('puts provenance on every account read (D13b)', async () => {
      const h = gateways.tradingPlatform();
      const sourced = accepted(await h.gateway.getAccountState(h.login()), 'getAccountState');
      expectProvenance(sourced);
      expect(sourced.data.login).toBe(h.login());
    });

    it('carries the contract fields this build depends on, with money in kobo', async () => {
      const h = gateways.tradingPlatform();
      const { data } = accepted(await h.gateway.getAccountState(h.login()), 'getAccountState');
      expect(typeof data.balanceKobo).toBe('bigint');
      expect(data.balanceKobo).toBe(koboFromString('1250000.00'));
      expect(data.withdrawableKobo).toBeTypeOf('bigint');
      expect(data.drawdownTimezone.length).toBeGreaterThan(0);
    });

    it('reports staleness from the gateway timestamp, not from our write time (D8, F1)', async () => {
      const stale = gateways.tradingPlatform({ staleAsOfMs: 11 * 60 * 1000 });
      const { asOf } = accepted(await stale.gateway.getAccountState(stale.login()), 'stale read');
      expect(isStale(asOf, new Date())).toBe(true);

      const fresh = gateways.tradingPlatform();
      const live = accepted(await fresh.gateway.getAccountState(fresh.login()), 'fresh read');
      expect(isStale(live.asOf, new Date())).toBe(false);
    });

    it('maps an unrecognised platform status to UNKNOWN, reports it, and holds the state (D13e)', async () => {
      const h = gateways.tradingPlatform();
      h.serveUnmappedStatus();
      const { data } = accepted(await h.gateway.getAccountState(h.login()), 'unmapped read');

      expect(data.status).toBe('UNKNOWN');
      expect(data.phase).toBe('UNKNOWN');
      expect(h.unmapped().map((event) => event.field)).toEqual(expect.arrayContaining(['status', 'phase']));
      // The point of UNKNOWN: nothing may infer a status transition from this read (D1).
      expect(canDriveStatusTransition({ ...data, complete: true })).toBe(false);
    });

    it('refuses a contract version this build has never seen (D13a)', async () => {
      const h = gateways.tradingPlatform();
      h.serveContractVersion(99);
      const refusal = refused(await h.gateway.getAccountState(h.login()), 'unknown contract version');
      expect(refusal.error).toBe('permanent');
      expect(refusal.detail).toContain('99');
    });

    it('refuses a payload with a required field absent, instead of defaulting it (D13a, D13b)', async () => {
      const h = gateways.tradingPlatform();
      const missing: (keyof AccountStateWire)[] = ['withdrawableKobo', 'drawdownLimitBps', 'asOf'];
      for (const field of missing) {
        h.serveMissingField(field);
        const refusal = refused(await h.gateway.getAccountState(h.login()), `missing ${field}`);
        expect(refusal.error).toBe('permanent');
        expect(refusal.detail).toContain(field);
      }
    });

    it('never uses incomplete data to drive a status transition (D13b)', async () => {
      const h = gateways.tradingPlatform({ profile: profileWith({ incompleteBps: 10_000 }) });
      const sourced = accepted(await h.gateway.getAccountState(h.login()), 'incomplete read');
      expect(sourced.complete).toBe(false);
      expect(canDriveStatusTransition({ ...sourced.data, complete: sourced.complete })).toBe(false);
    });

    it('separates transient from permanent from unsupported (D13c)', async () => {
      const h = gateways.tradingPlatform();
      for (const kind of ['transient', 'permanent', 'unsupported'] as const) {
        h.arm(kind);
        expect(refused(await h.gateway.getAccountState(h.login()), kind).error).toBe(kind);
      }
    });

    it('refuses an unknown login as permanent, not as an empty account', async () => {
      const h = gateways.tradingPlatform();
      expect(refused(await h.gateway.getAccountState('does-not-exist'), 'unknown login').error).toBe('permanent');
    });
  });

  describe(label('TradingPlatformGateway writes (D13c, D13d)'), () => {
    const provisionRequest = {
      idempotencyKey: 'idem-provision-1',
      userId: 'usr_test_1',
      productVersionId: 'prv_test_1',
      accountSizeKobo: koboFromString('10000000.00'),
      platform: 'mt5' as const,
    };

    it('returns a ticket and resolves it by polling, not by waiting on one call', async () => {
      const h = gateways.tradingPlatform();
      const ticket = accepted(await h.gateway.requestProvision(provisionRequest), 'requestProvision');
      expectProvenance(ticket);
      expect(ticket.data.id.length).toBeGreaterThan(0);

      // VERIFY: real provisioning takes minutes to days; a harness for a real platform must
      // observe the same open-then-closed sequence without a wall-clock wait.
      const open = accepted(await h.gateway.getProvision(ticket.data.id), 'getProvision (open)');
      expect(open.data.state).toBe('PENDING');
      const closed = accepted(await h.gateway.getProvision(ticket.data.id), 'getProvision (closed)');
      expect(closed.data.state).toBe('SUCCEEDED');
      expect(closed.data.login).toBeTruthy();
      // D11: a handle to the credential, never the credential itself.
      expect(closed.data).not.toHaveProperty('password');
    });

    it('on a lost provision response it created exactly one account and hands back a handle to reconcile (D13c)', async () => {
      const h = gateways.tradingPlatform();
      h.arm('unknown_outcome');
      const refusal = refused(await h.gateway.requestProvision(provisionRequest), 'provision timeout');

      expect(refusal.error).toBe('unknown_outcome');
      // The write did land, so the response must carry something to query with.
      expect(refusal.ref, 'unknown_outcome must carry a ticket or reference').toBeTruthy();
      expect(h.provisionWrites()).toBe(1);

      const resolved = accepted(await h.gateway.getProvision(refusal.ref ?? ''), 'reconcile by ticket');
      expect(['PENDING', 'SUCCEEDED']).toContain(resolved.data.state);
    });

    it('re-requesting with the same idempotency key never provisions twice', async () => {
      const h = gateways.tradingPlatform();
      h.arm('unknown_outcome');
      const first = refused(await h.gateway.requestProvision(provisionRequest), 'lost response');

      // A blind retry is what D13c forbids; the guard is that it would also be harmless.
      const replay = accepted(await h.gateway.requestProvision(provisionRequest), 'replayed provision');
      expect(replay.data.id).toBe(first.ref);
      expect(h.provisionWrites()).toBe(1);
    });

    it('a replay after a lost response never invents a second account, whatever the transport does', async () => {
      const h = gateways.tradingPlatform();
      h.arm('unknown_outcome');
      const first = refused(await h.gateway.requestProvision(provisionRequest), 'lost');
      h.arm('transient');
      // Whether the gateway replays the original ticket or refuses, the invariant is the same:
      // the platform holds one account for this key (D13c, D5).
      const replay = await h.gateway.requestProvision(provisionRequest);
      if (replay.ok) expect(replay.value.data.id).toBe(first.ref);
      expect(h.provisionWrites()).toBe(1);
      expect(first.ref).toBeTruthy();
    });

    it('resets follow the same ticket discipline', async () => {
      const h = gateways.tradingPlatform();
      const ticket = accepted(
        await h.gateway.requestReset({ idempotencyKey: 'idem-reset-1', userId: 'usr_test_1', login: h.login(), accountId: 'acc_test_1', reason: 'trader_request' }),
        'requestReset',
      );
      const open = accepted(await h.gateway.getReset(ticket.data.id), 'getReset (open)');
      expect(open.data.state).toBe('PENDING');
      const closed = accepted(await h.gateway.getReset(ticket.data.id), 'getReset (closed)');
      expect(closed.data.state).toBe('SUCCEEDED');
      expect(h.resetWrites()).toBe(1);
    });

    it('an unknown ticket is permanent, never a silently pending one', async () => {
      const h = gateways.tradingPlatform();
      expect(refused(await h.gateway.getProvision('tkt-nope'), 'unknown ticket').error).toBe('permanent');
      expect(refused(await h.gateway.getReset('tkt-nope'), 'unknown reset').error).toBe('permanent');
    });
  });

  describe(label('TradingPlatformGateway trades'), () => {
    it('pages with a cursor and reports what it could not finish (D13b)', async () => {
      const h = gateways.tradingPlatform();
      h.seedTrades(h.login(), [trade('t1', 100n), trade('t2', 200n), trade('t3', -50n)]);
      const query = { login: h.login(), from: new Date('2026-04-01T00:00:00Z'), to: new Date('2026-04-02T00:00:00Z') };

      const first = accepted(await h.gateway.listTrades({ ...query, limit: 2 }), 'page 1');
      expect(first.data.trades).toHaveLength(2);
      expect(first.data.nextCursor).toBeTruthy();

      const second = accepted(await h.gateway.listTrades({ ...query, limit: 2, cursor: first.data.nextCursor ?? undefined }), 'page 2');
      expect(second.data.trades.map((t) => t.platformTradeId)).toEqual(['t3']);
      expect(second.data.nextCursor).toBeNull();
      expectProvenance(first);
    });

    it('surfaces a missing capability as unsupported so the caller can switch it off (D13c)', async () => {
      const h = gateways.tradingPlatform({ profile: profileWith({ unsupportedBps: 10_000 }) });
      const refusal = refused(
        await h.gateway.listTrades({ login: h.login(), from: new Date(), to: new Date(), limit: 10 }),
        'no trade history',
      );
      expect(refusal.error).toBe('unsupported');
    });

    it('keeps money as kobo on the trade path', async () => {
      const h = gateways.tradingPlatform();
      h.seedTrades(h.login(), [trade('t1', 125_050n)]);
      const page = accepted(
        await h.gateway.listTrades({ login: h.login(), from: new Date('2026-04-01T00:00:00Z'), to: new Date('2026-04-02T00:00:00Z'), limit: 5 }),
        'trades',
      );
      expect(typeof page.data.trades[0]?.profitKobo).toBe('bigint');
      expect(page.data.trades[0]?.profitKobo).toBe(125_050n);
    });
  });

  describe(label('IdentityGateway (D9)'), () => {
    it('verifies a live token and reports who it belongs to', async () => {
      const h = gateways.identity();
      const sourced = accepted(await h.gateway.verifyToken(h.token()), 'verifyToken');
      expectProvenance(sourced);
      expect(sourced.data.userId).toBe(h.userId());
    });

    it('refuses an expired token as permanent', async () => {
      const h = gateways.identity();
      expect(refused(await h.gateway.verifyToken(h.expiredToken()), 'expired token').error).toBe('permanent');
    });

    it('refuses a revoked session after an upstream password reset (D9)', async () => {
      const h = gateways.identity();
      h.revokeSessions(h.userId());
      expect(refused(await h.gateway.verifyToken(h.token()), 'revoked session').error).toBe('permanent');
    });

    it('refuses an unknown user rather than returning an empty profile', async () => {
      const h = gateways.identity();
      expect(refused(await h.gateway.getUser('usr_nobody'), 'unknown user').error).toBe('permanent');
    });

    it('keeps transient failures distinguishable from refusals', async () => {
      const h = gateways.identity();
      h.arm('transient');
      expect(refused(await h.gateway.getUser(h.userId()), 'transient').error).toBe('transient');
      // A retry of the same read is safe: verification is not a write.
      const ok = accepted(await h.gateway.getUser(h.userId()), 'retry');
      expect(ok.data.userId).toBe(h.userId());
    });
  });

  describe(label('PaymentsGateway (D4, D5, D13f)'), () => {
    const order: ChargeReq = {
      idempotencyKey: 'idem-order-1',
      orderId: 'ord_test_1',
      amountKobo: koboFromString('250000.00'),
      customerRef: 'cus_ord_test_1',
    };

    it('creates a charge whose amount is exactly the requested kobo', async () => {
      const h = gateways.payments();
      const providerRef = await h.charge(order);
      const sourced = accepted(await h.gateway.getCharge(providerRef), 'getCharge');
      expectProvenance(sourced);
      expect(sourced.data.amountKobo).toBe(order.amountKobo);
      expect(sourced.data.status).toBe('INITIATED');
    });

    it('lets the processor hold an amount nobody asked for, and reports it truthfully on read (D13f)', async () => {
      const h = gateways.payments();
      // The misprice is arranged upstream because that is where the bug is: the app's only defence
      // is the confirmation read, and a gateway that always agrees cannot test it.
      h.mispriceNextCharge(koboFromString('2500.01'));
      const providerRef = await h.charge({ ...order, idempotencyKey: 'idem-order-mispriced' });
      const confirmed = accepted(await h.gateway.getCharge(providerRef), 'mispriced charge');
      expect(confirmed.data.amountKobo).toBe(koboFromString('2500.01'));
      expect(confirmed.data.amountKobo).not.toBe(order.amountKobo);
    });

    it('answers a fresh charge with a reference it has already issued, and creates nothing new', async () => {
      const h = gateways.payments();
      const first = await h.charge(order);
      // Arranged upstream again: only the processor decides what a reference means.
      h.reuseLastChargeRef();
      const second = await h.charge({ ...order, idempotencyKey: 'idem-order-reused-ref' });
      expect(second).toBe(first);
      // One charge sits behind two different answers. This app dedupes on (provider, providerRef)
      // (hard rule 4), so a caller that stored the second answer as its own would account the
      // same money twice — and overwrite the first owner's row while doing it.
      expect(h.chargeWrites()).toBe(1);
    });

    it('returns the same charge for a replayed idempotency key, and creates nothing new (D5)', async () => {
      const h = gateways.payments();
      const first = await h.charge(order);
      const second = await h.charge(order);
      expect(second).toBe(first);
      expect(h.chargeWrites()).toBe(1);
    });

    it('on a lost charge response, the charge exists and the reference reconciles it (D13c)', async () => {
      const h = gateways.payments();
      h.arm('unknown_outcome');
      const refusal = refused(
        await h.gateway.initCharge({ ...order, idempotencyKey: 'idem-order-lost' }),
        'lost charge response',
      );
      expect(refusal.error).toBe('unknown_outcome');
      expect(refusal.ref).toBeTruthy();
      expect(h.chargeWrites()).toBe(1);
      const confirmed = accepted(await h.gateway.getCharge(refusal.ref ?? ''), 'confirm by reference');
      expect(confirmed.data.amountKobo).toBe(order.amountKobo);
    });

    it('accepts a correctly signed webhook and yields a dedupe key (D5)', async () => {
      const h = gateways.payments();
      const providerRef = await h.charge(order);
      const webhook = await h.deliverWebhook(providerRef, 'completed');
      const sourced = accepted(await h.gateway.verifyWebhook(webhook), 'valid webhook');
      expectProvenance(sourced);
      expect(sourced.data.provider).toBeTruthy();
      expect(sourced.data.eventId).toBeTruthy();
      expect(sourced.data.providerRef).toBe(providerRef);
      expect(sourced.data.status).toBe('SUCCEEDED');
    });

    it('reports the webhook amount in the same kobo units as the charge, not the provider decimal string', async () => {
      const h = gateways.payments();
      const providerRef = await h.charge(order);
      const webhook = await h.deliverWebhook(providerRef, 'completed');
      const sourced = accepted(await h.gateway.verifyWebhook(webhook), 'amount');
      expect(sourced.data.amountKobo).toBe(order.amountKobo);
    });

    it('re-delivery of a webhook carries the same event id, so (provider, eventId) dedupe works (D5)', async () => {
      const h = gateways.payments({ profile: profileWith({ duplicateEventBps: 10_000 }) });
      const providerRef = await h.charge(order);
      const first = await h.deliverWebhook(providerRef, 'completed');
      const second = await h.deliverWebhook(providerRef, 'completed');

      const firstEvent = accepted(await h.gateway.verifyWebhook(first), 'first delivery');
      const secondEvent = accepted(await h.gateway.verifyWebhook(second), 'duplicate delivery');
      expect(h.duplicateDeliveries()).toBeGreaterThan(0);
      expect(secondEvent.data.eventId).toBe(firstEvent.data.eventId);
    });

    it('tolerates an event that arrives after a newer one (D13b)', async () => {
      const h = gateways.payments({ profile: profileWith({ outOfOrderBps: 10_000 }) });
      const providerRef = await h.charge(order);
      const pending = await h.deliverWebhook(providerRef, 'pending');
      accepted(await h.gateway.verifyWebhook(pending), 'pending event');
      const newer = await h.deliverWebhook(providerRef, 'completed');
      const newestAsOf = accepted(await h.gateway.verifyWebhook(newer), 'completed event').asOf;

      const late = await h.deliverWebhook(providerRef, 'completed');
      const outOfOrder = accepted(await h.gateway.verifyWebhook(late), 'out-of-order delivery');
      expect(h.outOfOrderDeliveries()).toBeGreaterThan(0);
      // Older than the newest event we already handled: the caller must compare timestamps.
      expect(outOfOrder.asOf.getTime()).toBeLessThanOrEqual(newestAsOf.getTime());
    });

    it('refuses a tampered signature and a missing signature, and verification itself writes nothing (hard rule 4)', async () => {
      const h = gateways.payments();
      const providerRef = await h.charge(order);
      const webhook = await h.deliverWebhook(providerRef, 'completed');
      // Snapshot the processor's whole record, so "nothing changed" covers every field. The
      // charge really did move to SUCCEEDED when the provider emitted the webhook — that is the
      // provider's ground truth, not our doing.
      const before = accepted(await h.gateway.getCharge(providerRef), 'charge before refusal');

      const tampered = refused(await h.gateway.verifyWebhook(h.tamperSignature(webhook)), 'tampered signature');
      expect(tampered.error).toBe('permanent');
      const unsigned = refused(
        await h.gateway.verifyWebhook({ rawBody: webhook.rawBody, headers: {} }),
        'missing signature',
      );
      expect(unsigned.error).toBe('permanent');

      // What a refused delivery must never do is leave the gateway holding a different charge.
      // Whether our own order moved is the purchase path's contract, asserted there.
      const after = accepted(await h.gateway.getCharge(providerRef), 'charge after refusal');
      expect(after.data).toEqual(before.data);
    });

    it('rejects a body the provider would never send, even when correctly signed', async () => {
      const h = gateways.payments();
      const refusal = refused(await h.gateway.verifyWebhook(h.foreignBody()), 'foreign body');
      expect(refusal.error).toBe('permanent');
    });

    it('holds an unmapped provider status as UNKNOWN and marks the event not whole (D13e)', async () => {
      const h = gateways.payments();
      const providerRef = await h.charge({ ...order, idempotencyKey: 'idem-order-chargeback' });
      const webhook = await h.deliverWebhook(providerRef, 'chargeback_disputed');
      const sourced = accepted(await h.gateway.verifyWebhook(webhook), 'unmapped status');

      expect(sourced.data.status).toBe('UNKNOWN');
      expect(sourced.complete).toBe(false);
      expect(h.unmapped().some((event) => event.field === 'status')).toBe(true);
    });

    it('confirms through getCharge that a webhook-reported success really landed (D13f)', async () => {
      const h = gateways.payments();
      const providerRef = await h.charge({ ...order, idempotencyKey: 'idem-order-confirm' });
      const webhook = await h.deliverWebhook(providerRef, 'completed');
      const event = accepted(await h.gateway.verifyWebhook(webhook), 'webhook');
      expect(event.data.status).toBe('SUCCEEDED');

      // The webhook alone is never the authority: fulfillment reads the charge back.
      const confirmed = accepted(await h.gateway.getCharge(event.data.providerRef), 'confirmation');
      expect(confirmed.data.status).toBe('SUCCEEDED');
      expect(confirmed.data.amountKobo).toBe(order.amountKobo);
    });

    it('refuses an unknown charge reference as permanent', async () => {
      const h = gateways.payments();
      expect(refused(await h.gateway.getCharge('chg_nobody'), 'unknown charge').error).toBe('permanent');
    });
  });

  describe(label('hostile profile keeps every result well-formed (D13g)'), () => {
    // Under full fault injection the seam may fail, but it may never lie: no thrown
    // exceptions, no bare payloads, no unlabelled failures.
    const seed = 20260401;

    it('every trading-platform call returns a typed result or provenanced data', async () => {
      const h = gateways.tradingPlatform({ profile: HOSTILE_FAULTS, seed });
      for (let i = 0; i < 40; i += 1) {
        const login = h.login();
        const calls: Promise<Result<Sourced<unknown>, GatewayError>>[] = [
          h.gateway.getAccountState(login),
          h.gateway.listTrades({ login, from: new Date('2026-04-01T00:00:00Z'), to: new Date('2026-04-02T00:00:00Z'), limit: 3 }),
          h.gateway.requestProvision({
            idempotencyKey: `hostile-${i}`,
            userId: 'usr_test_1',
            productVersionId: 'prv_test_1',
            accountSizeKobo: 1_000_000n,
            platform: 'mt5',
          }),
          h.gateway.getProvision(`tkt-${i}`),
        ];
        for (const call of calls) {
          const result = await call;
          if (result.ok) {
            expectProvenance(result.value);
          } else {
            expect(FAILURES).toContain(result.error);
            expect(result.detail, 'a failure must say why').toBeTruthy();
          }
        }
      }
    });

    it('every payment call returns a typed result or provenanced data', async () => {
      const h = gateways.payments({ profile: HOSTILE_FAULTS, seed });
      const providerRef = await h.charge({ idempotencyKey: 'hostile-charge', orderId: 'ord_test_1', amountKobo: 250_000n });
      const webhook = await h.deliverWebhook(providerRef, 'completed');

      for (let i = 0; i < 25; i += 1) {
        const results = await Promise.all([
          h.gateway.initCharge({ idempotencyKey: `hostile-${i}`, orderId: 'ord_test_1', amountKobo: 250_000n, customerRef: 'cus_test_1' }),
          h.gateway.getCharge(providerRef),
          h.gateway.verifyWebhook(webhook),
        ]);
        for (const result of results) {
          if (result.ok) expectProvenance(result.value);
          else expect(FAILURES).toContain(result.error);
        }
      }
    });

    it('an account read that yields UNKNOWN can never be mistaken for a verdict', async () => {
      const h = gateways.tradingPlatform({ profile: profileWith({ unknownEnumBps: 10_000 }) });
      const sourced = accepted(await h.gateway.getAccountState(h.login()), 'always-unmapped');
      const state: AccountState = sourced.data;
      expect(state.status).toBe('UNKNOWN');
      expect(canDriveStatusTransition({ ...state, complete: sourced.complete })).toBe(false);
    });
  });
}
