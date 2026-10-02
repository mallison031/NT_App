// D4: the price a trader is charged is the price they were quoted. A quote copies
// ChallengeProductVersion.priceKobo into its own row and the order copies it from there, so a
// catalog edit between quote and payment cannot change what a trader pays — and no request body
// can propose an amount either (the create schemas in @nt/shared are strict for that reason).

import type { Prisma, PrismaClient } from '@prisma/client';
import { koboToString, QUOTE_VALIDITY_MS, toUtcIsoString, type CatalogOfferJson, type QuoteJson } from '@nt/shared';
import { AppError, invalidRequest } from '../errors';
import { findOffer, offerOf, purchasableVersion, type VersionRow } from '../catalog/service';

type QuoteRow = Prisma.PriceQuoteGetPayload<Record<string, never>>;

export type RedeemedQuote = { quote: QuoteRow; version: VersionRow; offer: CatalogOfferJson };

/** A quote whose deadline has passed may not open an order, whatever the client last saw. */
export const isQuoteExpired = (expiresAt: Date, now: Date): boolean => expiresAt.getTime() <= now.getTime();

export const quoteToJson = (quote: {
  id: string;
  versionId: string;
  amountKobo: bigint;
  expiresAt: Date;
  createdAt: Date;
}): QuoteJson => ({
  id: quote.id,
  productVersionId: quote.versionId,
  amountKobo: koboToString(quote.amountKobo),
  expiresAt: toUtcIsoString(quote.expiresAt),
  createdAt: toUtcIsoString(quote.createdAt),
});

/**
 * `PriceQuote.userId` is the local user row's id, not the identity system's: every other relation
 * in the schema hangs off the local id, and a quote has to belong to the same kind of subject as
 * the order that consumes it.
 */
export async function createQuote(
  db: PrismaClient,
  userId: string,
  productVersionId: string,
  now: Date,
): Promise<QuoteJson> {
  if (productVersionId.trim() === '') throw invalidRequest('productVersionId is required');

  const lookup = await findOffer(db, productVersionId, now);
  if (!lookup.ok) {
    const messages: Record<typeof lookup.reason, string> = {
      offer_not_found: 'no such offer',
      offer_not_for_sale: 'this offer is not for sale right now',
      offer_rule_unreadable: 'this offer cannot be priced because its rule row cannot be read',
    };
    throw new AppError(
      lookup.reason,
      409,
      messages[lookup.reason],
      'issues' in lookup ? lookup.issues.join('; ') : undefined,
    );
  }

  const quote = await db.priceQuote.create({
    data: {
      userId,
      versionId: lookup.version.id,
      amountKobo: lookup.version.priceKobo,
      expiresAt: new Date(now.getTime() + QUOTE_VALIDITY_MS),
    },
  });
  return quoteToJson(quote);
}

export async function getQuote(db: PrismaClient, quoteId: string, userId: string): Promise<QuoteJson> {
  const quote = await db.priceQuote.findUnique({ where: { id: quoteId } });
  // Someone else's quote id reads as "not found" on purpose: a "belongs to another trader" answer
  // would confirm which quote ids are live.
  if (!quote || quote.userId !== userId) throw new AppError('quote_not_found', 404, 'no such quote');
  return quoteToJson(quote);
}

/**
 * The check an order creation makes before it spends a quote: ours, unexpired, unspent, and still
 * pointing at a version that is on sale. The *amount* is never re-read from the version here; it
 * comes from the quote row (D4). Re-checking saleability only closes the door on a product that
 * went off sale in the meantime.
 * VERIFY: PRD does not say whether an already-quoted product may be bought after it is withdrawn;
 * the owner decides, and this is the one line that changes.
 */
export async function redeemableQuote(
  db: PrismaClient,
  quoteId: string,
  userId: string,
  now: Date,
): Promise<RedeemedQuote> {
  const quote = await db.priceQuote.findUnique({ where: { id: quoteId } });
  if (!quote || quote.userId !== userId) throw new AppError('quote_not_found', 404, 'no such quote');
  if (isQuoteExpired(quote.expiresAt, now)) {
    throw new AppError('quote_expired', 409, 'this price is no longer held; ask for a new quote');
  }

  const spent = await db.order.findUnique({ where: { quoteId } });
  if (spent) throw new AppError('quote_already_used', 409, 'this quote already has an order');

  const version = await purchasableVersion(db, quote.versionId, now);
  if (!version) throw new AppError('offer_not_for_sale', 409, 'this offer is no longer for sale');

  const offer = offerOf(version);
  if ('issues' in offer) {
    throw new AppError(
      'offer_rule_unreadable',
      409,
      'this offer cannot be bought because its rule row cannot be read',
      offer.issues.join('; '),
    );
  }

  if (koboToString(quote.amountKobo) !== offer.priceKobo) {
    throw new QuotedPriceDrifted(quote.id, koboToString(quote.amountKobo), offer.priceKobo);
  }

  return { quote, version, offer };
}

/**
 * A version row whose price no longer matches the quote taken from it. D3's model says this
 * cannot happen: a catalog edit is a new row with a new `effectiveFrom`, never a mutation of a
 * row that is already being quoted, and that is what keeps "charged amount equals quoted amount"
 * (F2) away from rule drift. If it does happen, the catalog writer is broken, and the one thing
 * this build must not do is pick one of the two numbers and charge it.
 * VERIFY: owner confirms catalog edits always create a new version row rather than editing one.
 */
export class QuotedPriceDrifted extends Error {
  public constructor(quoteId: string, quoted: string, row: string) {
    super(`quote ${quoteId} carries ${quoted} but its version row now says ${row}`);
    this.name = 'QuotedPriceDrifted';
  }
}
