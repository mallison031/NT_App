// The catalog is the only place a price or a rule is read, and both come out of the row rather
// than out of this file (D3, hard rule 10). Nothing here encodes a drawdown limit, a phase count
// or a naira amount: PRD section 6 shows public sources disagreeing about all three, so the app
// renders whichever version row is effective, and the version row is the owner's to write.

import type { Prisma, PrismaClient } from '@prisma/client';
import { koboToString, parsePhaseRules, toUtcIsoString, type CatalogOfferJson } from '@nt/shared';

export type VersionRow = Prisma.ChallengeProductVersionGetPayload<{ include: { product: true } }>;

/**
 * `reason` values are API error codes: the caller turns a refusal into the response without
 * re-reading this module's idea of what a product row means.
 */
export type OfferLookup =
  | { ok: true; offer: CatalogOfferJson; version: VersionRow }
  | { ok: false; reason: 'offer_not_found' }
  | { ok: false; reason: 'offer_not_for_sale' }
  | { ok: false; reason: 'offer_rule_unreadable'; issues: string[] };

export type OfferList = {
  offers: CatalogOfferJson[];
  /** A row this build cannot read withholds its offer; the response says so rather than lying. */
  complete: boolean;
  unreadable: { productVersionId: string; issues: string[] }[];
};

/**
 * What "buyable right now" means, in one place: an active product, a version whose effective
 * window covers this instant, and not sold out. Quotes and orders re-check through this filter,
 * because a catalog page can sit open longer than a quote stays valid.
 */
const purchasableWhere = (now: Date): Prisma.ChallengeProductVersionWhereInput => ({
  soldOut: false,
  effectiveFrom: { lte: now },
  OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
  product: { is: { active: true } },
});

/** Wire form of a version row, or the reasons it cannot be shown. Rules are parsed, not passed through raw. */
export function offerOf(version: VersionRow): CatalogOfferJson | { issues: string[] } {
  const rules = parsePhaseRules(version.phaseRules);
  if (!rules.ok) return rules;
  return {
    productVersionId: version.id,
    productSlug: version.product.slug,
    productName: version.product.name,
    accountSizeKobo: koboToString(version.accountSizeKobo),
    priceKobo: koboToString(version.priceKobo),
    phaseCount: version.phaseCount,
    phaseRules: rules.rules,
    fundedDrawdownBps: version.fundedDrawdownBps,
    profitShareBps: version.profitShareBps,
    registrationRefundable: version.registrationRefundable,
    resetAllowed: version.resetAllowed,
    effectiveFrom: toUtcIsoString(version.effectiveFrom),
  };
}

const asVersionRow = (db: PrismaClient, id: string, now: Date): Promise<VersionRow | null> =>
  db.challengeProductVersion.findFirst({ where: { id, ...purchasableWhere(now) }, include: { product: true } });

export async function listOffers(db: PrismaClient, now: Date): Promise<OfferList> {
  const versions = await db.challengeProductVersion.findMany({
    where: purchasableWhere(now),
    include: { product: true },
    orderBy: [{ accountSizeKobo: 'asc' }, { effectiveFrom: 'desc' }],
  });

  const offers: CatalogOfferJson[] = [];
  const unreadable: { productVersionId: string; issues: string[] }[] = [];
  for (const version of versions) {
    const offer = offerOf(version);
    if ('issues' in offer) unreadable.push({ productVersionId: version.id, issues: offer.issues });
    else offers.push(offer);
  }
  return { offers, complete: unreadable.length === 0, unreadable };
}

/**
 * A purchasable version by id. Whether a *different* version became effective since is not this
 * function's question: D4 says the quote binds the price, and superseding a live quote would be
 * exactly the price drift the review complaints are about.
 */
export async function findOffer(db: PrismaClient, productVersionId: string, now: Date): Promise<OfferLookup> {
  const version = await asVersionRow(db, productVersionId, now);
  if (version) {
    const offer = offerOf(version);
    if ('issues' in offer) return { ok: false, reason: 'offer_rule_unreadable', issues: offer.issues };
    return { ok: true, offer, version };
  }
  // Distinguish "no such version" from "this version is not for sale": a trader who is told the
  // product does not exist will file a different ticket from one who is told it is closed.
  const anyVersion = await db.challengeProductVersion.findUnique({ where: { id: productVersionId } });
  return { ok: false, reason: anyVersion ? 'offer_not_for_sale' : 'offer_not_found' };
}

/** The version a quote points at, re-checked at use time. Used by the order path. */
export const purchasableVersion = (db: PrismaClient, id: string, now: Date): Promise<VersionRow | null> =>
  asVersionRow(db, id, now);
