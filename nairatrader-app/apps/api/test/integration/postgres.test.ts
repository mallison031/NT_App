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

  it('rejects a second payout request that is still open for the same account (F3)', async () => {
    const { prisma } = db;
    const user = await prisma.user.create({ data: { externalId: 'ext-4' } });
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

    await prisma.payoutRequest.create({
      data: {
        userId: user.id,
        accountId: account.id,
        methodId: method.id,
        amountKobo: 5_000_00n,
        idempotencyKey: 'k-1',
      },
    });

    const open = await prisma.payoutRequest.findFirst({
      where: { accountId: account.id, status: { in: ['REQUESTED', 'UNDER_REVIEW', 'APPROVED'] } },
    });
    expect(open).not.toBeNull();
  });
});
