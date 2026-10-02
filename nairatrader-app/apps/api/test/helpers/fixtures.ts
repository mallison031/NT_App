// Database fixtures. The offers created here are placeholders that let a test or a developer walk
// the purchase path; they are not the catalog. Real prices and rule numbers are the owner's to set
// (PRD section 6 records that public sources disagree), which is why no seed file ships them and
// why the README keeps this in the owner-blocked list.

import type { Prisma, PrismaClient } from '@prisma/client';
import type { Kobo } from '@nt/shared';

export type SeededOffer = {
  productVersionId: string;
  slug: string;
  priceKobo: Kobo;
  accountSizeKobo: Kobo;
};

const DEFAULT_RULES = [
  { phase: 'EVAL_1', profitTargetBps: 3000, maxDrawdownBps: 1000, dailyDrawdownBps: 500, deadlineDays: 30 },
  { phase: 'EVAL_2', profitTargetBps: 1500, maxDrawdownBps: 1000 },
];

let offers = 0;

/**
 * One active product with one effective version. `effectiveFrom` sits before the test clock's
 * start, so the version is on sale the moment a quote is asked for.
 */
export async function seedOffer(
  prisma: PrismaClient,
  overrides: {
    priceKobo?: Kobo;
    accountSizeKobo?: Kobo;
    phaseRules?: Prisma.InputJsonValue;
    soldOut?: boolean;
    effectiveTo?: Date;
    active?: boolean;
  } = {},
): Promise<SeededOffer> {
  const slug = `fixture-offer-${(offers += 1)}`;
  const priceKobo = overrides.priceKobo ?? 250_000n; // ₦2,500.00
  const accountSizeKobo = overrides.accountSizeKobo ?? 1_000_000_000n; // ₦10,000,000.00

  const version = await prisma.challengeProductVersion.create({
    data: {
      accountSizeKobo,
      priceKobo,
      phaseCount: DEFAULT_RULES.length,
      phaseRules: overrides.phaseRules ?? DEFAULT_RULES,
      fundedDrawdownBps: 1000,
      profitShareBps: 8000,
      soldOut: overrides.soldOut ?? false,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      effectiveTo: overrides.effectiveTo ?? null,
      product: {
        create: {
          slug,
          name: 'Fixture offer (not a real product)',
          active: overrides.active ?? true,
        },
      },
    },
    include: { product: true },
  });

  return { productVersionId: version.id, slug, priceKobo, accountSizeKobo };
}

/**
 * One container per file, one clean database per test, so a failure never depends on which test
 * ran first. `_prisma_migrations` is left alone because `db push` tracks its own state there.
 */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  const tables = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY tablename",
  );
  if (tables.length === 0) return;
  const list = tables.map((table) => `"${table.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}
