// The fault injector is what makes "tested against the easy case" impossible, so its own rules
// are pinned here: profiles start from a clean baseline, invalid rates are refused at
// construction, and a seeded run reproduces exactly.

import { describe, expect, it } from 'vitest';
import {
  assertFaultProfile,
  createFaultInjector,
  createRandomness,
  FaultProfileError,
  HOSTILE_FAULTS,
  NO_FAULTS,
  profileWith,
} from '../../src/gateways/fault-profile';

describe('profileWith', () => {
  it('starts from a clean baseline and changes only what you name', () => {
    const profile = profileWith({ transientBps: 500 });
    expect(profile.transientBps).toBe(500);
    expect(profile.permanentBps).toBe(0);
    expect(profile.unknownOutcomeBps).toBe(0);
    expect(profile.staleAsOfMs).toBe(0);
    expect(profile.latencyMs).toEqual({ min: 0, max: 0 });
  });

  it('merges a partial latency range without losing the other bound', () => {
    expect(profileWith({ latencyMs: { max: 40 } }).latencyMs).toEqual({ min: 0, max: 40 });
    expect(profileWith({ latencyMs: { min: 5, max: 40 } }).latencyMs).toEqual({ min: 5, max: 40 });
  });

  it('does not alias the caller object or NO_FAULTS itself', () => {
    const overrides = { latencyMs: { min: 1, max: 2 } };
    const profile = profileWith(overrides);
    profile.latencyMs.max = 9;
    expect(overrides.latencyMs.max).toBe(2);
    expect(NO_FAULTS.latencyMs).toEqual({ min: 0, max: 0 });
  });
});

describe('assertFaultProfile', () => {
  const reject = (overrides: Parameters<typeof profileWith>[0]): void => {
    expect(() => profileWith(overrides)).toThrow(FaultProfileError);
  };

  it('refuses rates outside basis points', () => {
    reject({ permanentBps: -1 });
    reject({ unsupportedBps: 10_001 });
    reject({ incompleteBps: 12.5 });
    reject({ unknownEnumBps: Number.NaN });
  });

  it('refuses an impossible latency range and a negative staleness offset', () => {
    reject({ latencyMs: { min: 80, max: 20 } });
    reject({ latencyMs: { min: 0, max: 1.5 } });
    reject({ staleAsOfMs: -1 });
  });

  it('names the offending key, so a bad profile is quick to find', () => {
    expect(() => profileWith({ outOfOrderBps: 99_999 })).toThrow(/outOfOrderBps/);
  });

  it('accepts both shipped profiles, including the hostile one at full rates', () => {
    expect(() => assertFaultProfile(NO_FAULTS)).not.toThrow();
    expect(() => assertFaultProfile(HOSTILE_FAULTS)).not.toThrow();
  });

  it('validates a profile built without going through profileWith', () => {
    expect(() => createFaultInjector({ ...NO_FAULTS, transientBps: 50_000 })).toThrow(FaultProfileError);
  });
});

describe('createRandomness', () => {
  it('reproduces a run from the same seed, which is the whole reason it exists', () => {
    const draw = (seed: number): number[] => {
      const random = createRandomness(seed);
      return Array.from({ length: 20 }, () => random.nextUint32());
    };
    expect(draw(20260401)).toEqual(draw(20260401));
    expect(draw(20260401)).not.toEqual(draw(20260402));
  });

  it('refuses a seed that cannot produce a stream', () => {
    // xorshift32 is a fixed point at zero, so seed 0 would emit forever.
    expect(() => createRandomness(0)).toThrow(FaultProfileError);
    expect(() => createRandomness(1.5)).toThrow(FaultProfileError);
  });

  it('is always-true at 10000bps and never-true at 0', () => {
    const random = createRandomness(7);
    expect(random.chance(10_000)).toBe(true);
    expect(Array.from({ length: 50 }, () => random.chance(0))).toEqual(Array(50).fill(false));
  });

  it('stays inside an inclusive range and holds a single-value range', () => {
    const random = createRandomness(11);
    for (const value of Array.from({ length: 200 }, () => random.range(3, 9))) {
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThanOrEqual(9);
      expect(Number.isInteger(value)).toBe(true);
    }
    expect(random.range(0, 0)).toBe(0);
  });
});

describe('createFaultInjector', () => {
  it('rolls the named rate and nothing else', () => {
    const always = createFaultInjector(profileWith({ incompleteBps: 10_000 }), 3);
    expect(always.roll('incompleteBps')).toBe(true);
    expect(always.roll('transientBps')).toBe(false);
  });

  it('draws latency inside the profile range', () => {
    const injector = createFaultInjector(profileWith({ latencyMs: { min: 10, max: 25 } }), 5);
    for (const ms of Array.from({ length: 100 }, () => injector.latencyMs())) {
      expect(ms).toBeGreaterThanOrEqual(10);
      expect(ms).toBeLessThanOrEqual(25);
    }
  });

  it('stamps asOf from the profile offset, which is how D13b staleness is exercised', () => {
    const injector = createFaultInjector(profileWith({ staleAsOfMs: 660_000 }), 5);
    const now = new Date('2026-04-01T12:00:00Z');
    expect(injector.asOf(now).toISOString()).toBe('2026-04-01T11:49:00.000Z');
    expect(NO_FAULTS.staleAsOfMs).toBe(0);
  });

  it('reproduces a sequence of rolls for a seed, so a failure can be re-run exactly', () => {
    const hostile = (seed: number): boolean[] => {
      const injector = createFaultInjector(HOSTILE_FAULTS, seed);
      return Array.from({ length: 40 }, () => injector.roll('transientBps') || injector.roll('incompleteBps'));
    };
    expect(hostile(20260401)).toEqual(hostile(20260401));
    // Both rates are armed, so the run must actually mix outcomes: an all-one-side stream
    // would mean the hostile profile is not hostile.
    const stream = hostile(20260401);
    expect(stream).toContain(true);
    expect(stream).toContain(false);
  });

  it('keeps the profile it was built with readable for reporting', () => {
    const profile = profileWith({ unsupportedBps: 300 });
    expect(createFaultInjector(profile, 1).profile).toBe(profile);
  });
});
