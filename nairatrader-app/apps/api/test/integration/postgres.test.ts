import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isDockerUp, startTestDb, type TestDb } from '../helpers/postgres';

const dockerAvailable = await isDockerUp();
const skip = !dockerAvailable && !process.env.CI;

if (!dockerAvailable) {
  const why = process.env.CI ? 'CI has no docker daemon' : 'no docker daemon; start colima';
  console.warn(`[db.test] integration tests skipped: ${why}`);
}

describe.skipIf(skip)('postgres round trip', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await startTestDb();
  });

  afterAll(async () => {
    await db?.stop();
  });

  it('stores money as BigInt kobo without precision loss', async () => {
    const { prisma } = db;
    const user = await prisma.user.create({ data: { externalId: 'ext-1', email: null } });
    const amountKobo = 10_000_000_000_000n;

    const account = await prisma.tradingAccount.create({
      data: { userId: user.id, balanceKobo: amountKobo },
    });

    expect(account.balanceKobo).toBe(amountKobo);
    expect(account.status).toBe('PENDING_PROVISION');
  });

  it('accepts UNKNOWN as a stored account status (D13e)', async () => {
    const { prisma } = db;
    const user = await prisma.user.create({ data: { externalId: 'ext-2' } });
    const account = await prisma.tradingAccount.create({
      data: { userId: user.id, status: 'UNKNOWN' },
    });
    expect(account.status).toBe('UNKNOWN');
  });

  it('carries the provenance columns D13b requires on every account read', async () => {
    const { prisma } = db;
    const user = await prisma.user.create({ data: { externalId: 'ext-3' } });
    const asOf = new Date('2026-09-30T10:00:00Z');
    const account = await prisma.tradingAccount.create({
      data: { userId: user.id, asOf, stateSource: 'risk-engine-exporter', contractVersion: 1 },
    });
    expect(account.asOf).toEqual(asOf);
    expect(account.contractVersion).toBe(1);
  });

  it('starts an account incomplete and holds the contract numbers it later caches (D13b)', async () => {
    const { prisma } = db;
    const user = await prisma.user.create({ data: { externalId: 'ext-5' } });
    const created = await prisma.tradingAccount.create({ data: { userId: user.id } });
    // No read has proved this account whole yet, so the default has to be the pessimistic one.
    expect(created.stateComplete).toBe(false);

    const synced = await prisma.tradingAccount.update({
      where: { id: created.id },
      data: {
        stateComplete: true,
        profitTargetBps: 3000,
        drawdownLimitBps: 1000,
        drawdownUsedBps: 120,
        drawdownTimezone: 'Africa/Lagos',
        balanceKobo: 125_000_000n,
      },
    });
    expect(synced).toMatchObject({
      stateComplete: true,
      profitTargetBps: 3000,
      drawdownLimitBps: 1000,
      drawdownUsedBps: 120,
      drawdownTimezone: 'Africa/Lagos',
    });
    expect(synced.balanceKobo).toBe(125_000_000n);
  });

  it('stores every UNKNOWN the seam can produce, so a held value is never a guess (D13e)', async () => {
    const { prisma } = db;
    const user = await prisma.user.create({ data: { externalId: 'ext-6' } });
    const account = await prisma.tradingAccount.create({ data: { userId: user.id, phase: 'UNKNOWN' } });
    expect(account.phase).toBe('UNKNOWN');

    // A payment whose provider status nobody mapped is recorded as UNKNOWN rather than
    // defaulted to SUCCEEDED, which is the difference between holding an order and paying out
    // on money we never confirmed.
    const order = await prisma.order.create({
      data: {
        // A nested quote create forces Prisma's checked input, which wants the relation rather
        // than the scalar id.
        user: { connect: { id: user.id } },
        idempotencyKey: 'idem-int-1',
        quote: {
          create: {
            userId: user.id,
            amountKobo: 250_000n,
            expiresAt: new Date('2026-04-01T00:00:00Z'),
            version: {
              create: {
                accountSizeKobo: 10_000_000_000n,
                priceKobo: 250_000n,
                phaseCount: 3,
                phaseRules: [],
                fundedDrawdownBps: 1000,
                profitShareBps: 8000,
                effectiveFrom: new Date('2026-01-01T00:00:00Z'),
                product: { create: { slug: 'int-fixture', name: 'Integration fixture' } },
              },
            },
          },
        },
        payments: { create: [{ provider: 'fixture', providerRef: 'evt-int-1', amountKobo: 250_000n, status: 'UNKNOWN' }] },
      },
      include: { payments: true },
    });
    expect(order.payments[0]?.status).toBe('UNKNOWN');
  });

  it('carries a payout through PENDING_RECONCILE, the state a lost response parks it in (D13c)', async () => {
    const { prisma } = db;
    const user = await prisma.user.create({ data: { externalId: 'ext-7' } });
    const account = await prisma.tradingAccount.create({ data: { userId: user.id } });
    const method = await prisma.payoutMethod.create({
      data: {
        userId: user.id,
        bankCode: '058',
        accountNumberEnc: new Uint8Array([1, 2, 3]),
        accountLast4: '1234',
        accountName: 'A TRADER',
      },
    });

    const payout = await prisma.payoutRequest.create({
      data: {
        userId: user.id,
        accountId: account.id,
        methodId: method.id,
        amountKobo: 500_00n,
        idempotencyKey: 'payout-reconcile-1',
      },
    });
    const parked = await prisma.payoutRequest.update({
      where: { id: payout.id },
      data: { status: 'PENDING_RECONCILE' },
    });
    expect(parked.status).toBe('PENDING_RECONCILE');

    // The same key must not start a second request: this is what makes the reconcile job's
    // retry harmless. (That only *one* payout may be open per account, F3, is a service rule
    // and no constraint enforces it here — it lands with the payout module in Phase 3.)
    await expect(
      prisma.payoutRequest.create({
        data: {
          userId: user.id,
          accountId: account.id,
          methodId: method.id,
          amountKobo: 500_00n,
          idempotencyKey: 'payout-reconcile-1',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});
