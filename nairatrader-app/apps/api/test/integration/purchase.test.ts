// F2, D4, D5, D7 and D13c-f seen from outside: real HTTP requests against a real Postgres, with
// the hostile Fakes standing in for the processor and the platform. The point of driving it over
// the wire is that a test cannot cheat — a wrong status code, a leaked field, a second charge or a
// state that skips an edge all show up here.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OrderStatus, PaymentStatus, QUOTE_VALIDITY_MS, type Kobo } from '@nt/shared';
import type { ReconcileReport } from '../../src/jobs/reconcile-pending';
import { isDockerUp, startTestDb, type TestDb } from '../helpers/postgres';
import { resetDatabase, seedOffer, type SeededOffer } from '../helpers/fixtures';
import {
  asCatalog,
  asOrder,
  asQuote,
  codeOf,
  createTestApp,
  deliverWebhook,
  fetchOrder,
  getJson,
  jsonOf,
  orderFor,
  postJson,
  providerRefOf,
  sessionToken,
  TEST_START,
  type TestApp,
} from '../helpers/http';

const dockerAvailable = await isDockerUp();
const skip = !dockerAvailable && !process.env.CI;

if (!dockerAvailable) {
  const why = process.env.CI ? 'CI has no docker daemon' : 'no docker daemon; start colima';
  console.warn(`[purchase.test] integration tests skipped: ${why}`);
}

type Effect = { effect: string };

describe.skipIf(skip)('the purchase path over HTTP', () => {
  let db: TestDb;
  let t: TestApp;

  beforeAll(async () => {
    db = await startTestDb();
  });

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await resetDatabase(db.prisma);
    // A fresh app per test: the fakes hold their world in memory, so an armed fault or a stored
    // charge cannot leak from one case into the next.
    t = createTestApp(db);
  });

  afterEach(async () => {
    await t.app.close();
  });

  /** A trader with a session and exactly one offer on sale. */
  async function ready(): Promise<{ token: string; offer: SeededOffer }> {
    const offer = await seedOffer(t.prisma);
    return { offer, token: await sessionToken(t) };
  }

  const reconcile = async (): Promise<ReconcileReport> =>
    jsonOf<ReconcileReport>(await postJson(t, '/v1/dev/reconcile', {}));

  describe('the trader journey (F2, D3, D4, D13f)', () => {
    it('runs catalog to a provisioned account without writing a status the platform owns', async () => {
      const { token, offer } = await ready();

      const catalog = asCatalog(await getJson(t, '/v1/catalog'));
      expect(catalog).toEqual({
        offers: [
          expect.objectContaining({
            productVersionId: offer.productVersionId,
            accountSizeKobo: '10000000.00',
            priceKobo: '2500.00',
          }),
        ],
        complete: true,
      });


      const { order, quote } = await orderFor(t, token, offer.productVersionId, 'order-happy-0001');
      // D4: the amount charged is the amount quoted, and both came from the version row.
      expect(quote.amountKobo).toBe('2500.00');
      expect(order.amountKobo).toBe('2500.00');
      expect(order.status).toBe(OrderStatus.PendingPayment);
      expect(order.payment?.status).toBe(PaymentStatus.Initiated);
      expect(order.account).toMatchObject({ status: 'PENDING_PROVISION', login: null });

      const providerRef = providerRefOf(order, 'charge initiated');
      const delivered = await deliverWebhook(t, t.fakes.payments.webhookFor(providerRef, 'completed'));
      expect(delivered.statusCode).toBe(200);
      expect(jsonOf<Effect>(delivered).effect).toBe('paid');

      const paid = await fetchOrder(t, token, order.id);
      expect(paid.status).toBe(OrderStatus.Fulfilling);
      expect(paid.payment?.status).toBe(PaymentStatus.Succeeded);
      // The fake platform keeps its ticket open for one read (D13d), so nothing is fulfilled yet.
      expect(paid.account?.login).toBeNull();

      expect(reconcileNow(await reconcile())).toEqual([{ orderId: order.id, result: 'fulfilled' }]);

      const done = await fetchOrder(t, token, order.id);
      expect(done.status).toBe(OrderStatus.Fulfilled);
      expect(done.account?.login).toMatch(/^\d{6,}$/);

      const accountId = done.account?.id;
      if (accountId === undefined) throw new Error('the fulfilled order carries no account');
      const stored = await t.prisma.tradingAccount.findUniqueOrThrow({ where: { id: accountId } });
      // D1: fulfilment hands over a login and a credential handle, and stops there. Whether the
      // account is in evaluation, passed or breached is the risk engine's answer (Phase 4), and
      // D11 keeps the password itself out of the database.
      expect(stored.status).toBe('PENDING_PROVISION');
      expect(stored.mtCredentialHandle).toBe(`mt5-credentials/${done.account?.login}`);
      expect(stored.credentialsEnc).toBeNull();

      // D3: the rules are frozen on the account at purchase, not read back from the catalog.
      const snapshot = await t.prisma.accountRuleSnapshot.findUniqueOrThrow({ where: { accountId } });
      expect(snapshot.versionId).toBe(offer.productVersionId);

      // One account created, however many times the trader's requests arrived.
      expect(t.fakes.tradingPlatform.provisionWrites).toBe(1);
      const audit = await t.prisma.auditLog.findMany({ where: { entityId: order.id } });
      expect(audit.map((row) => row.action).sort()).toEqual(
        ['order.charge_initiated', 'order.created', 'order.fulfilled', 'payment.paid', 'provision.requested'].sort(),
      );
    });

    it('binds the quoted deadline to the clock the app runs on, not the client’s', async () => {
      const { token, offer } = await ready();
      const quote = asQuote(await postJson(t, '/v1/quotes', { productVersionId: offer.productVersionId }, { token }));
      // The wire form is UTC with no milliseconds, so the fifteen minutes are checked as written.
      expect(quote.expiresAt).toBe('2026-04-01T09:15:00Z');
    });

    it('refuses to open an order on an expired quote, and opens nothing', async () => {
      const { token, offer } = await ready();
      const quote = asQuote(await postJson(t, '/v1/quotes', { productVersionId: offer.productVersionId }, { token }));
      t.clock.advance(QUOTE_VALIDITY_MS);

      const refused = await postJson(t, '/v1/orders', { quoteId: quote.id }, { token, key: 'order-expired-0001' });
      expect([refused.statusCode, codeOf(refused)]).toEqual([409, 'quote_expired']);
      expect(await t.prisma.order.count()).toBe(0);
    });

    it('will not let a client propose a price, an amount or a status (D4, hard rule 8)', async () => {
      const { token, offer } = await ready();
      const attempts = [
        { productVersionId: offer.productVersionId, priceKobo: '1.00' },
        { productVersionId: offer.productVersionId, accountSizeKobo: '1.00' },
      ];
      for (const body of attempts) {
        const refused = await postJson(t, '/v1/quotes', body, { token });
        expect([refused.statusCode, codeOf(refused)]).toEqual([400, 'invalid_request']);
      }
      const orderAttempt = await postJson(
        t,
        '/v1/orders',
        { quoteId: 'q_1', amountKobo: '1.00' },
        { token, key: 'order-body-0001' },
      );
      expect([orderAttempt.statusCode, codeOf(orderAttempt)]).toEqual([400, 'invalid_request']);
    });

    it('withholds an offer whose rule row it cannot read, instead of guessing the rules (D3, D13e)', async () => {
      const { token } = await ready();
      const unreadable = await seedOffer(t.prisma, { phaseRules: [] });

      const catalog = asCatalog(await getJson(t, '/v1/catalog'));
      expect(catalog.offers).toHaveLength(1);
      expect(catalog.complete).toBe(false);

      const refused = await postJson(t, '/v1/quotes', { productVersionId: unreadable.productVersionId }, { token });
      expect([refused.statusCode, codeOf(refused)]).toEqual([409, 'offer_rule_unreadable']);
    });

    it('refuses to quote an offer that is not on sale', async () => {
      const { token } = await ready();
      const soldOut = await seedOffer(t.prisma, { soldOut: true });
      const withdrawn = await seedOffer(t.prisma, { effectiveTo: new Date(TEST_START.getTime() - 1000) });

      // Only the offer from `ready()` is still on sale.
      expect(asCatalog(await getJson(t, '/v1/catalog')).offers).toHaveLength(1);
      for (const offer of [soldOut, withdrawn]) {
        const refused = await postJson(t, '/v1/quotes', { productVersionId: offer.productVersionId }, { token });
        expect([refused.statusCode, codeOf(refused)]).toEqual([409, 'offer_not_for_sale']);
      }
    });

    it('shows one trader nothing of another’s quote or order', async () => {
      const { token, offer } = await ready();
      const { order, quote } = await orderFor(t, token, offer.productVersionId, 'order-owner-0001');
      const intruder = await sessionToken(t, 'ext-trader-2');

      expect((await getJson(t, `/v1/orders/${order.id}`, { token: intruder })).statusCode).toBe(404);
      expect((await getJson(t, `/v1/quotes/${quote.id}`, { token: intruder })).statusCode).toBe(404);

      const stolen = await postJson(t, '/v1/orders', { quoteId: quote.id }, { token: intruder, key: 'order-intruder-01' });
      expect([stolen.statusCode, codeOf(stolen)]).toEqual([404, 'quote_not_found']);
      expect(await t.prisma.order.count()).toBe(1);
    });
  });

  describe('idempotency (D5, hard rule 3)', () => {
    it('replays the first answer for a repeated key without asking the processor again', async () => {
      const { token, offer } = await ready();
      const quote = asQuote(await postJson(t, '/v1/quotes', { productVersionId: offer.productVersionId }, { token }));

      const first = await postJson(t, '/v1/orders', { quoteId: quote.id }, { token, key: 'order-replay-0001' });
      const again = await postJson(t, '/v1/orders', { quoteId: quote.id }, { token, key: 'order-replay-0001' });

      expect(again.statusCode).toBe(first.statusCode);
      // The replayed answer is the first one, which is what a client acts on. Key order is not
      // compared: the record round-trips through Postgres JSON, and JSON objects are unordered.
      expect(jsonOf<unknown>(again)).toEqual(jsonOf<unknown>(first));
      expect(asOrder(again).id).toBe(asOrder(first).id);
      expect(await t.prisma.order.count()).toBe(1);
      expect(t.fakes.payments.initCharges).toBe(1);
    });

    it('refuses one key used for a different request', async () => {
      const { token, offer } = await ready();
      const first = await orderFor(t, token, offer.productVersionId, 'order-conflict-001');
      const other = await seedOffer(t.prisma, { priceKobo: 300_000n });
      const secondQuote = asQuote(await postJson(t, '/v1/quotes', { productVersionId: other.productVersionId }, { token }));

      const clash = await postJson(t, '/v1/orders', { quoteId: secondQuote.id }, { token, key: 'order-conflict-001' });
      expect([clash.statusCode, codeOf(clash)]).toEqual([409, 'idempotency_conflict']);
      expect(asOrder(await getJson(t, `/v1/orders/${first.order.id}`, { token })).status).toBe(
        OrderStatus.PendingPayment,
      );
      expect(await t.prisma.order.count()).toBe(1);
    });

    it('refuses a money request that brings no usable key', async () => {
      const { token, offer } = await ready();
      const quote = asQuote(await postJson(t, '/v1/quotes', { productVersionId: offer.productVersionId }, { token }));

      const missing = await postJson(t, '/v1/orders', { quoteId: quote.id }, { token });
      expect([missing.statusCode, codeOf(missing)]).toEqual([400, 'missing_idempotency_key']);

      const malformed = await postJson(t, '/v1/orders', { quoteId: quote.id }, { token, key: 'short' });
      expect([malformed.statusCode, codeOf(malformed)]).toEqual([400, 'invalid_request']);
      expect(await t.prisma.order.count()).toBe(0);
    });

    it('does not cache a refusal: a transient gateway answer can be retried with the same key (D13c)', async () => {
      const { token, offer } = await ready();
      const quote = asQuote(await postJson(t, '/v1/quotes', { productVersionId: offer.productVersionId }, { token }));
      t.fakes.payments.forceNext('transient');

      const refused = await postJson(t, '/v1/orders', { quoteId: quote.id }, { token, key: 'order-transient-001' });
      expect([refused.statusCode, codeOf(refused)]).toEqual([503, 'gateway_transient']);
      const opened = await t.prisma.order.findFirstOrThrow({ where: { quoteId: quote.id } });
      expect(opened.status).toBe(OrderStatus.PendingPayment);
      expect(await t.prisma.payment.count()).toBe(0);

      // The retry finds the order the first attempt committed and drives the same charge key.
      const retried = await postJson(t, '/v1/orders', { quoteId: quote.id }, { token, key: 'order-transient-001' });
      expect(retried.statusCode).toBe(200);
      expect(jsonOf<{ id: string }>(retried).id).toBe(opened.id);
      expect(await t.prisma.payment.count()).toBe(1);
      expect(t.fakes.payments.initCharges).toBe(1);
    });
  });

  describe('webhook receipt (hard rule 4, D13f)', () => {
    it('refuses bytes its signature does not cover, and writes nothing', async () => {
      const { token, offer } = await ready();
      const { order } = await orderFor(t, token, offer.productVersionId, 'order-tamper-0001');
      const delivery = t.fakes.payments.webhookFor(providerRefOf(order, 'charge initiated'), 'completed');

      const refused = await deliverWebhook(t, delivery, { tamper: true });
      expect([refused.statusCode, codeOf(refused)]).toEqual([400, 'invalid_request']);
      expect(await t.prisma.webhookEvent.count()).toBe(0);
      expect((await fetchOrder(t, token, order.id)).status).toBe(OrderStatus.PendingPayment);
    });

    it('believes the charge it reads back, not the notification it received (D13f)', async () => {
      const { token, offer } = await ready();
      const { order } = await orderFor(t, token, offer.productVersionId, 'order-believe-01');
      const providerRef = providerRefOf(order, 'charge initiated');

      // A correctly signed delivery claiming success for a charge the processor still holds as
      // initiated. Built by hand rather than through webhookFor, because webhookFor is the
      // provider acting and would move the charge for real.
      const claimsSuccess = t.fakes.payments.signAsProvider(
        JSON.stringify({
          id: 'evt-claims-success',
          event: 'charge.completed',
          data: {
            id: providerRef,
            reference: providerRef,
            amount: '2500.00',
            status: 'completed',
            createdAt: TEST_START.toISOString(),
          },
        }),
      );

      expect(jsonOf<Effect>(await deliverWebhook(t, claimsSuccess)).effect).toBe('held');
      const held = await fetchOrder(t, token, order.id);
      expect(held.status).toBe(OrderStatus.PendingReconcile);
      expect(held.payment?.status).toBe(PaymentStatus.Unknown);
      // Nothing was provisioned on the strength of a notification (D13d).
      expect(t.fakes.tradingPlatform.provisionWrites).toBe(0);
    });

    it('processes one event once, whatever the delivery count (D5)', async () => {
      const { token, offer } = await ready();
      const { order } = await orderFor(t, token, offer.productVersionId, 'order-dup-00001');
      const delivery = t.fakes.payments.webhookFor(providerRefOf(order, 'charge initiated'), 'completed');

      expect(jsonOf<Effect>(await deliverWebhook(t, delivery)).effect).toBe('paid');
      expect(jsonOf<Effect>(await deliverWebhook(t, delivery)).effect).toBe('duplicate');

      expect(await t.prisma.webhookEvent.count()).toBe(1);
      expect(await t.prisma.payment.count()).toBe(1);
      expect((await fetchOrder(t, token, order.id)).status).toBe(OrderStatus.Fulfilling);
      expect(t.fakes.tradingPlatform.provisionWrites).toBe(1);
    });

    it('is unbothered by an event that arrives after the one that superseded it', async () => {
      const { token, offer } = await ready();
      const { order } = await orderFor(t, token, offer.productVersionId, 'order-order-0001');
      const providerRef = providerRefOf(order, 'charge initiated');

      const pending = t.fakes.payments.webhookFor(providerRef, 'pending');
      expect(jsonOf<Effect>(await deliverWebhook(t, pending)).effect).toBe('held');
      expect((await fetchOrder(t, token, order.id)).status).toBe(OrderStatus.PendingReconcile);

      const completed = t.fakes.payments.webhookFor(providerRef, 'completed');
      expect(jsonOf<Effect>(await deliverWebhook(t, completed)).effect).toBe('paid');
      expect((await fetchOrder(t, token, order.id)).status).toBe(OrderStatus.Fulfilling);

      // The older delivery arrives again, now behind the newer one. It changes nothing, because
      // the decision reads the charge, and the charge is already accounted for.
      expect(jsonOf<Effect>(await deliverWebhook(t, pending)).effect).toBe('held');
      expect((await fetchOrder(t, token, order.id)).status).toBe(OrderStatus.Fulfilling);
      expect(await t.prisma.payment.count()).toBe(1);
    });

    it('closes an event the processor has never heard of, with a written reason', async () => {
      const { token, offer } = await ready();
      const { order } = await orderFor(t, token, offer.productVersionId, 'order-unknown-01');
      const delivery = t.fakes.payments.webhookFor(providerRefOf(order, 'charge initiated'), 'completed');
      t.fakes.payments.forceNext('permanent', 'the processor does not know this charge');

      const unmatched = await deliverWebhook(t, delivery);
      expect([unmatched.statusCode, jsonOf<Effect>(unmatched).effect]).toEqual([200, 'unmatched']);
      expect((await fetchOrder(t, token, order.id)).status).toBe(OrderStatus.PendingPayment);

      const event = await t.prisma.webhookEvent.findFirstOrThrow();
      expect(event.processedAt).not.toBeNull();
      const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'webhook.unmatched' } });
      expect(audit.after).toMatchObject({ reason: 'the processor does not know this charge' });
    });

    it('treats a charge held for a different amount than the quote as a contradiction, not a payment', async () => {
      const { token, offer } = await ready();
      const providerHolds: Kobo = 250_001n; // ₦2,500.01 against a ₦2,500.00 quote
      t.fakes.payments.mispriceNextCharge(providerHolds);

      const quote = asQuote(await postJson(t, '/v1/quotes', { productVersionId: offer.productVersionId }, { token }));
      const mismatched = await postJson(t, '/v1/orders', { quoteId: quote.id }, { token, key: 'order-mismatch-1' });
      expect([mismatched.statusCode, codeOf(mismatched)]).toEqual([409, 'amount_mismatch']);

      const stored = await t.prisma.payment.findFirstOrThrow({ where: { order: { quoteId: quote.id } } });
      expect(stored.status).toBe(PaymentStatus.AmountMismatch);
      expect(stored.amountKobo).toBe(providerHolds);
      expect((await t.prisma.order.findFirstOrThrow({ where: { quoteId: quote.id } })).status).toBe(
        OrderStatus.PendingPayment,
      );

      // Retrying the same key asks the processor again rather than replaying a cached success —
      // and the answer is still a mismatch, so nothing about the money quietly changes.
      const retried = await postJson(t, '/v1/orders', { quoteId: quote.id }, { token, key: 'order-mismatch-1' });
      expect([retried.statusCode, codeOf(retried)]).toEqual([409, 'amount_mismatch']);
      expect(await t.prisma.payment.count()).toBe(1);
    });
  });

  describe('held orders (D13c)', () => {
    it('holds a lost charge answer, reconciles it, and only then fulfils the order', async () => {
      const { token, offer } = await ready();
      const quote = asQuote(await postJson(t, '/v1/quotes', { productVersionId: offer.productVersionId }, { token }));
      t.fakes.payments.forceNext('unknown_outcome', 'timed out after the charge was created');

      const held = await postJson(t, '/v1/orders', { quoteId: quote.id }, { token, key: 'order-lost-00001' });
      expect(held.statusCode).toBe(202);
      const heldOrder = asOrder(held);
      expect(heldOrder.status).toBe(OrderStatus.PendingReconcile);
      expect(heldOrder.payment?.status).toBe(PaymentStatus.Unknown);
      expect(t.fakes.payments.initCharges).toBe(1);

      // The processor still holds the charge as initiated, so the answer stays open. The pass
      // reports that and changes nothing — no second charge, no invented status.
      expect(reconcileNow(await reconcile())).toEqual([{ orderId: heldOrder.id, result: 'held' }]);
      expect(t.fakes.payments.initCharges).toBe(1);
      expect((await fetchOrder(t, token, heldOrder.id)).status).toBe(OrderStatus.PendingReconcile);

      // The provider's own delivery settles it, and the same pass then drives provisioning.
      const settled = await deliverWebhook(t, t.fakes.payments.webhookFor(providerRefOf(heldOrder, 'hold'), 'completed'));
      expect(jsonOf<Effect>(settled).effect).toBe('paid');
      expect(reconcileNow(await reconcile())).toEqual([{ orderId: heldOrder.id, result: 'fulfilled' }]);
      expect((await fetchOrder(t, token, heldOrder.id)).status).toBe(OrderStatus.Fulfilled);
    });

    it('parks an order whose provisioning ticket cannot be read, and resumes it through the same key', async () => {
      const { token, offer } = await ready();
      const { order } = await orderFor(t, token, offer.productVersionId, 'order-ticket-0001');
      await deliverWebhook(t, t.fakes.payments.webhookFor(providerRefOf(order, 'charge initiated'), 'completed'));
      const fulfilling = await fetchOrder(t, token, order.id);
      expect(fulfilling.status).toBe(OrderStatus.Fulfilling);

      // The platform loses the answer to a ticket read: the pass holds the order rather than
      // re-issuing a provisioning request that might create a second account.
      t.fakes.tradingPlatform.forceNext('unknown_outcome', 'the ticket read timed out');
      expect(reconcileNow(await reconcile())).toEqual([{ orderId: order.id, result: 'held' }]);
      expect((await fetchOrder(t, token, order.id)).status).toBe(OrderStatus.PendingReconcile);
      expect(t.fakes.tradingPlatform.provisionWrites).toBe(1);

      // Resumed: the charge is already confirmed, so the pass goes back to FULFILLING and polls
      // the ticket it holds. Still one account created.
      expect(reconcileNow(await reconcile())).toEqual([{ orderId: order.id, result: 'fulfilled' }]);
      expect(t.fakes.tradingPlatform.provisionWrites).toBe(1);
      expect((await fetchOrder(t, token, order.id)).account?.login).toMatch(/^\d{6,}$/);
    });

    it('names an order the processor denies instead of re-issuing its charge', async () => {
      const { token, offer } = await ready();
      const quote = asQuote(await postJson(t, '/v1/quotes', { productVersionId: offer.productVersionId }, { token }));
      t.fakes.payments.forceNext('unknown_outcome', 'timed out after the charge was created');
      const held = asOrder(await postJson(t, '/v1/orders', { quoteId: quote.id }, { token, key: 'order-denied-001' }));

      // Forget the charge on the processor's side, which is what a wrong or lost reference means.
      t.fakes.payments.forceNext('permanent', 'no such charge');
      expect(reconcileNow(await reconcile())).toEqual([{ orderId: held.id, result: 'needs_attention' }]);
      expect(t.fakes.payments.initCharges).toBe(1);
      expect((await fetchOrder(t, token, held.id)).status).toBe(OrderStatus.PendingReconcile);

      const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'reconcile.charge_denied' } });
      expect(audit.entityId).toBe(held.id);
    });

    it('will not write a charge answer onto another order’s payment row', async () => {
      const { token, offer } = await ready();
      const { order: owned } = await orderFor(t, token, offer.productVersionId, 'order-refa-0001');
      const refA = providerRefOf(owned, 'charge initiated');

      // The processor sells the second order a reference it already issued to the first. The
      // request itself is clean — a fresh quote and a fresh Idempotency-Key — so only the answer
      // contradicts this database, and (provider, providerRef) is where that has to surface.
      t.fakes.payments.reuseLastChargeRef();
      const nextQuote = asQuote(await postJson(t, '/v1/quotes', { productVersionId: offer.productVersionId }, { token }));
      const reply = await postJson(t, '/v1/orders', { quoteId: nextQuote.id }, { token, key: 'order-refb-0001' });

      expect(reply.statusCode).toBe(202);
      const held = asOrder(reply);
      expect(held.status).toBe(OrderStatus.PendingReconcile);
      expect(held.payment).toBeNull();
      // One charge behind two orders, and nothing recorded for the second one.
      expect(t.fakes.payments.initCharges).toBe(1);
      expect(await t.prisma.payment.count()).toBe(1);

      // The first order still owns its charge. This is the regression the guard exists for: an
      // overwritten row would move money backwards, a SUCCEEDED charge to INITIATED, and silently
      // hand the trader's paid-for account to whoever asked last.
      const stillOwned = await t.prisma.payment.findFirstOrThrow({ where: { providerRef: refA } });
      expect(stillOwned.orderId).toBe(owned.id);
      expect(stillOwned.status).toBe(PaymentStatus.Initiated);
      expect((await fetchOrder(t, token, owned.id)).status).toBe(OrderStatus.PendingPayment);

      // With no handle of its own the pass cannot read a money question back, so it names the
      // order for a person rather than re-issuing the charge (D13c).
      expect(reconcileNow(await reconcile())).toEqual([{ orderId: held.id, result: 'needs_attention' }]);
      expect(t.fakes.payments.initCharges).toBe(1);

      const heldAudit = await t.prisma.auditLog.findFirstOrThrow({
        where: { entityId: held.id, action: 'order.pending_reconcile' },
      });
      expect(heldAudit.after).toMatchObject({
        providerRef: null,
        reason: expect.stringContaining(refA),
      });
    });
  });

  describe('session and composition (D9)', () => {
    it('touches no user row for a public read, and one for a private one', async () => {
      await seedOffer(t.prisma);

      // The catalog is nobody's data, so it answers without a token and without a user.
      expect((await getJson(t, '/v1/catalog')).statusCode).toBe(200);
      expect(await t.prisma.user.count()).toBe(0);

      const anonymous = await getJson(t, '/v1/quotes/q_1');
      expect([anonymous.statusCode, codeOf(anonymous)]).toEqual([401, 'unauthorized']);

      // The first authenticated request is where the local user row appears: identity is
      // delegated (D9), so this app owns a subject only once a token has been verified.
      const token = await sessionToken(t);
      const missing = await getJson(t, '/v1/orders/order-nobody-here', { token });
      expect([missing.statusCode, codeOf(missing)]).toEqual([404, 'not_found']);
      expect(await t.prisma.user.count()).toBe(1);
    });

    it('says the identity system is unavailable rather than answering as an anonymous caller', async () => {
      const token = await sessionToken(t);
      t.fakes.identity.forceNext('transient');

      const unavailable = await getJson(t, '/v1/orders/any-order', { token });
      expect([unavailable.statusCode, codeOf(unavailable)]).toEqual([503, 'gateway_transient']);
    });

    it('reports which gateway implementations are wired in', async () => {
      const health = jsonOf<{ ok: boolean; gateways: Record<string, string> }>(await getJson(t, '/healthz'));
      expect(health).toEqual({ ok: true, gateways: { trading: 'fake', identity: 'fake', payments: 'fake' } });
    });
  });
});

/** Only the two facts a test cares about, so a report change shows up as a diff. */
function reconcileNow(report: ReconcileReport): { orderId: string; result: string }[] {
  return report.results.map((row) => ({ orderId: row.orderId, result: row.result }));
}
