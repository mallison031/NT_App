// D2 / hard rule 1: money is integer kobo in the database and a decimal string in JSON.
// This is the only module allowed to convert between the two. Floats cannot hold kobo
// amounts (an 8-figure naira balance is 10 figures of kobo, and account balances go past
// 2^53), so every function here works on BigInt or on digit strings.

export type Kobo = bigint;

/** Naira amount as a decimal string, at most two fractional digits, e.g. "1250.00". */
export type KoboString = string;

// JSON.stringify throws on a BigInt, and a BigInt is exactly one of the values this
// module has to refuse, so error labels are built without it.
const describeValue = (value: unknown): string => {
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  return String(value);
};

export class KoboParseError extends Error {
  public constructor(received: unknown) {
    // The value is echoed for the operator, not for the user: bad kobo is always a
    // bug in our code or in an upstream payload.
    super(`not a kobo decimal string: ${describeValue(received)}`);
    this.name = 'KoboParseError';
  }
}

const KOBO_PER_NAIRA = 100n;

/** Optional sign, digits, and up to two fractional digits. Nothing else is accepted. */
const DECIMAL_PATTERN = /^-?\d+(\.\d{1,2})?$/;

/**
 * Wire-form validator. Used directly by the Zod schemas in `schemas/`, so a payload
 * carrying "1e3", "12.345", "NaN" or a float-serialized 17-digit number fails at the
 * boundary instead of silently rounding.
 */
export const isKoboString = (value: unknown): value is KoboString =>
  typeof value === 'string' && DECIMAL_PATTERN.test(value);

/** JSON wire form -> BigInt kobo. Throws KoboParseError rather than guessing. */
export function koboFromString(value: unknown): Kobo {
  if (!isKoboString(value)) throw new KoboParseError(value);
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const kobo = BigInt(`${whole ?? '0'}${fraction.padEnd(2, '0')}`);
  return negative ? -kobo : kobo;
}

/** BigInt kobo -> JSON wire form. Exact for every BigInt, including past 2^53. */
export function koboToString(kobo: Kobo): KoboString {
  const negative = kobo < 0n;
  const magnitude = negative ? -kobo : kobo;
  const whole = magnitude / KOBO_PER_NAIRA;
  const fraction = magnitude % KOBO_PER_NAIRA;
  return `${negative ? '-' : ''}${whole.toString()}.${fraction.toString().padStart(2, '0')}`;
}

const groupDigits = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * Display string, e.g. "1,250,000.00". Grouping is done on the digit string:
 * Intl/toLocaleString would first require a Number, which is the loss this module exists
 * to avoid.
 */
export function koboToDisplayString(kobo: Kobo): string {
  const [whole, fraction] = koboToString(kobo).split('.');
  const negative = (whole ?? '').startsWith('-');
  const grouped = groupDigits((whole ?? '').replace('-', ''));
  return `${negative ? '-' : ''}${grouped}.${fraction ?? '00'}`;
}

/** The "₦1,250,000.00" form the PRD's F1 dashboard shows; the sign leads the symbol. */
export function formatNaira(kobo: Kobo): string {
  if (kobo < 0n) return `-₦${koboToDisplayString(-kobo)}`;
  return `₦${koboToDisplayString(kobo)}`;
}

export class BpsError extends Error {
  public constructor(received: unknown) {
    super(`not a whole basis-point value: ${String(received)}`);
    this.name = 'BpsError';
  }
}

// D2: percentages are stored as basis points (3000 = 30%), so a rule edit cannot drift
// through a float. These guards keep a stray 30.5 or 3e7 out of the arithmetic.
function assertBps(bps: number): void {
  if (!Number.isSafeInteger(bps) || bps < 0) throw new BpsError(bps);
}

/**
 * `bps` percent of `kobo`, truncating toward zero. Truncation is deliberate: rounding a
 * charge up would bill the trader for kobo the rule row never authorised. Payment amounts
 * come from PriceQuote rows, never from this function, so no user-visible charge is ever
 * derived here.
 */
export function applyBps(kobo: Kobo, bps: number): Kobo {
  assertBps(bps);
  return (kobo * BigInt(bps)) / 10_000n;
}

/** Basis points -> display label: 3000 -> "30%", 750 -> "7.5%", 3001 -> "30.01%". */
export function bpsToPercentLabel(bps: number): string {
  assertBps(bps);
  const whole = Math.floor(bps / 100);
  const fraction = String(bps % 100).padStart(2, '0').replace(/0+$/, '');
  return fraction === '' ? `${whole}%` : `${whole}.${fraction}%`;
}

/**
 * Summing kobo from a gateway page of trades. Kept explicit because `Array.reduce` on
 * BigInt has no identity by default, and mixing Number into a sum of money is how the
 * precision bug class starts.
 */
export const sumKobo = (values: readonly Kobo[]): Kobo => values.reduce((total, v) => total + v, 0n);
