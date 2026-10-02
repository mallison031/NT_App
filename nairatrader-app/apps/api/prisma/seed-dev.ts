// Dev-only seed. It exists so `pnpm dev` can walk the purchase path end to end: without a version
// row there is no catalog, and without a catalog there is no quote to order.
//
// Every number below is a placeholder. PRD section 6 records that public sources disagree on
// account sizes, prices, targets and drawdown limits, so the real ones are the owner's to set —
// see the owner-blocked list in the README. Nothing in the app reads these values as a rule: the
// catalog service renders whatever row is effective (D3), and the risk engine's numbers arrive
// through the Account State Contract (D1).
//
// Re-runnable: rows are found by slug and replaced in place, so the catalog does not stack
// duplicate versions of the same placeholder offer.

import { loadEnv } from '../src/config/env';
import { createDb } from '../src/db';

const EFFECTIVE_FROM = new Date('2026-01-01T00:00:00Z');

/** Two evaluation phases: the second is a shorter target on the same drawdown limits. */
const PLACEHOLDER_RULES = [
  { phase: 'EVAL_1', profitTargetBps: 3000, maxDrawdownBps: 1000, dailyDrawdownBps: 500, deadlineDays: 30 },
  { phase: 'EVAL_2', profitTargetBps: 1500, maxDrawdownBps: 1000 },
];

const OFFERS = [
  {
    slug: 'dev-eval-10m',
    name: 'DEV PLACEHOLDER 10M — not a real product or price',
    // Money is BigInt kobo end to end (D2): a ₦10,000,000.00 size at a ₦1,000.00 price.
    accountSizeKobo: 1_000_000_000n,
    priceKobo: 100_000n,
  },
  {
    slug: 'dev-eval-25m',
    name: 'DEV PLACEHOLDER 25M — not a real product or price',
    accountSizeKobo: 2_500_000_000n,
    priceKobo: 250_000n,
  },
] as const;

async function main(): Promise<void> {
  const db = createDb(loadEnv());
  try {
    for (const offer of OFFERS) {
      const product = await db.challengeProduct.upsert({
        where: { slug: offer.slug },
        create: { slug: offer.slug, name: offer.name, active: true },
        update: { name: offer.name, active: true },
      });
      const version = await db.challengeProductVersion.findFirst({ where: { productId: product.id } });
      const data = {
        accountSizeKobo: offer.accountSizeKobo,
        priceKobo: offer.priceKobo,
        phaseCount: PLACEHOLDER_RULES.length,
        phaseRules: PLACEHOLDER_RULES,
        fundedDrawdownBps: 1000,
        profitShareBps: 8000,
        registrationRefundable: false,
        resetAllowed: true,
        soldOut: false,
        effectiveFrom: EFFECTIVE_FROM,
        effectiveTo: null,
      };
      if (version === null) await db.challengeProductVersion.create({ data: { productId: product.id, ...data } });
      else await db.challengeProductVersion.update({ where: { id: version.id }, data });
      console.log(`seeded ${offer.slug} (placeholder numbers)`);
    }
  } finally {
    await db.$disconnect();
  }
}

await main();
