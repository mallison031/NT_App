import { describe, expect, it } from 'vitest';
import {
  applyBps,
  BpsError,
  bpsToPercentLabel,
  formatNaira,
  isKoboString,
  KoboParseError,
  koboFromString,
  koboToDisplayString,
  koboToString,
  sumKobo,
} from '../src/money';

describe('kobo <-> decimal string (D2)', () => {
  it('round-trips the wire form without losing kobo', () => {
    for (const wire of ['0.00', '0.01', '1250.00', '99999999.99', '-0.05', '-1250.50']) {
      expect(koboToString(koboFromString(wire))).toBe(wire);
    }
  });

  it('parses the smallest unit exactly', () => {
    expect(koboFromString('0.01')).toBe(1n);
    expect(koboFromString('1')).toBe(100n);
    expect(koboFromString('1250.5')).toBe(125_050n);
  });

  // The bug class the whole money rule exists to stop: a balance that a float cannot hold.
  it('stays exact past 2^53, where Number would silently change the amount', () => {
    const kobo = 9_007_199_254_740_993n; // 2^53 + 1
    const wire = koboToString(kobo);
    expect(wire).toBe('90071992547409.93');
    expect(koboFromString(wire)).toBe(kobo);
    expect(koboFromString(wire) === BigInt(Number.MAX_SAFE_INTEGER) + 2n).toBe(true);
  });

  it('keeps the sign on sub-naira negatives', () => {
    expect(koboFromString('-0.05')).toBe(-5n);
    expect(koboToString(-5n)).toBe('-0.05');
  });

  it('refuses anything that is not a plain two-decimal string', () => {
    const rejected: unknown[] = [
      '',
      '   ',
      '.50',
      '1.',
      '+1.00',
      '1.234',
      '1e3',
      '1E3',
      'NaN',
      'Infinity',
      '-Infinity',
      '1,250.00',
      '₦1250',
      '0x10',
      '9.999999999999999',
      1250,
      1250n,
      null,
      undefined,
      true,
      {},
      [],
    ];
    for (const value of rejected) {
      expect(isKoboString(value), String(value)).toBe(false);
      expect(() => koboFromString(value), String(value)).toThrow(KoboParseError);
    }
  });

  // A BigInt is the one rejected type that breaks naive error formatting, because
  // JSON.stringify throws on it. The failure must stay a KoboParseError.
  it('reports a BigInt input without crashing the error path', () => {
    expect(() => koboFromString(125_000n)).toThrow(/not a kobo decimal string: 125000n/);
  });

  // Tolerant on the way in, exact on the way out: a producer that sends whole naira
  // is accepted, and koboToString always emits two decimals back.
  it('accepts amounts written without cents', () => {
    expect(koboFromString('1250')).toBe(125_000n);
    expect(koboFromString('1250.0')).toBe(125_000n);
    expect(koboToString(koboFromString('1250'))).toBe('1250.00');
  });
});

describe('display formatting', () => {
  it('groups thousands without going through Number', () => {
    expect(koboToDisplayString(125_000_000n)).toBe('1,250,000.00');
    expect(koboToDisplayString(999n)).toBe('9.99');
    expect(koboToDisplayString(1_000_000_000n)).toBe('10,000,000.00');
    expect(formatNaira(125_000_000n)).toBe('₦1,250,000.00');
    expect(formatNaira(0n)).toBe('₦0.00');
    expect(formatNaira(-12_3456n)).toBe('-₦1,234.56');
  });

  it('groups a past-2^53 amount correctly', () => {
    expect(koboToDisplayString(9_007_199_254_740_993n)).toBe('90,071,992,547,409.93');
  });
});

describe('basis points (D2)', () => {
  it('applies a rule percentage as exact integer math', () => {
    expect(applyBps(10_000_000_000_000n, 3000)).toBe(3_000_000_000_000n);
    expect(applyBps(125_050n, 10000)).toBe(125_050n);
    expect(applyBps(1n, 1)).toBe(0n);
  });

  it('truncates toward zero rather than rounding a trader up', () => {
    expect(applyBps(99n, 100)).toBe(0n); // 0.99 kobo
    expect(applyBps(101n, 100)).toBe(1n);
    expect(applyBps(-101n, 100)).toBe(-1n);
  });

  it('labels percentages for the UI', () => {
    expect(bpsToPercentLabel(3000)).toBe('30%');
    expect(bpsToPercentLabel(750)).toBe('7.5%');
    expect(bpsToPercentLabel(3001)).toBe('30.01%');
    expect(bpsToPercentLabel(0)).toBe('0%');
    expect(bpsToPercentLabel(10000)).toBe('100%');
    expect(bpsToPercentLabel(27)).toBe('0.27%');
  });

  it('refuses fractional, negative or unsafe basis points', () => {
    for (const bad of [30.5, -1, NaN, Infinity, 2 ** 53]) {
      expect(() => applyBps(100n, bad)).toThrow(BpsError);
      expect(() => bpsToPercentLabel(bad)).toThrow(BpsError);
    }
  });
});

describe('sumKobo', () => {
  it('adds without an intermediate float', () => {
    expect(sumKobo([])).toBe(0n);
    expect(sumKobo([1n, 2n, 3n])).toBe(6n);
    const big = [9_007_199_254_740_993n, 1n];
    expect(sumKobo(big)).toBe(9_007_199_254_740_994n);
  });
});
