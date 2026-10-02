// D13g: the hostile Fake. Every unknown about a real integration has a failure mode behind it
// — slow responses, data that is hours old, a webhook delivered twice, an event that arrives
// after the one that superseded it, a write that timed out *after* it succeeded, an enum value
// nobody mapped, a payload with fields missing. If the fakes behave perfectly, the app is only
// ever tested against the easy case, and the first real integration is the outage.
//
// Rates are basis points integers (D2's convention) and randomness is seeded, so a fault that
// breaks a test can be re-run exactly.

export type FaultProfile = {
  /** Simulated call duration, drawn uniformly from this range. */
  latencyMs: { min: number; max: number };
  /** How far behind the present the gateway reports its data timestamp. 0 = live. */
  staleAsOfMs: number;
  /** D13c retry-with-backoff failures. */
  transientBps: number;
  /** Hard refusals: bad login, closed account, auth rejected. */
  permanentBps: number;
  /** D13c capability missing, surfaced as feature-off rather than an error to the user. */
  unsupportedBps: number;
  /**
   * D13c timeout-after-success. The operation lands downstream and the caller is told the
   * outcome is unknown. This is the fault that makes blind retries dangerous, so the fake
   * performs the downstream effect *before* failing.
   */
  unknownOutcomeBps: number;
  /** Duplicate delivery of an event that was already emitted. */
  duplicateEventBps: number;
  /** Events delivered in the wrong order. */
  outOfOrderBps: number;
  /** A value outside the adapter's mapping table (D13e). */
  unknownEnumBps: number;
  /** A payload that is not whole, which must never drive a transition (D13b). */
  incompleteBps: number;
};

const RATE_KEYS = [
  'transientBps',
  'permanentBps',
  'unsupportedBps',
  'unknownOutcomeBps',
  'duplicateEventBps',
  'outOfOrderBps',
  'unknownEnumBps',
  'incompleteBps',
] as const;

/** Behaves like a well-behaved gateway: no injected faults, live timestamps. */
export const NO_FAULTS: FaultProfile = {
  latencyMs: { min: 0, max: 0 },
  staleAsOfMs: 0,
  transientBps: 0,
  permanentBps: 0,
  unsupportedBps: 0,
  unknownOutcomeBps: 0,
  duplicateEventBps: 0,
  outOfOrderBps: 0,
  unknownEnumBps: 0,
  incompleteBps: 0,
};

/** Every fault armed at a moderate rate: what the contract suite runs the gateways against. */
export const HOSTILE_FAULTS: FaultProfile = {
  latencyMs: { min: 0, max: 2 },
  staleAsOfMs: 11 * 60 * 1000, // 11 minutes: past D8's 5 minute staleness badge
  transientBps: 1500,
  permanentBps: 500,
  unsupportedBps: 300,
  unknownOutcomeBps: 800,
  duplicateEventBps: 1200,
  outOfOrderBps: 1000,
  unknownEnumBps: 900,
  incompleteBps: 700,
};

export class FaultProfileError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'FaultProfileError';
  }
}

/**
 * Overrides for `profileWith`. The latency range is partial on purpose: naming one bound and
 * inheriting the other is the common case when arming a single fault.
 */
export type FaultProfileOverrides = Omit<Partial<FaultProfile>, 'latencyMs'> & {
  latencyMs?: Partial<FaultProfile['latencyMs']>;
};

export const profileWith = (overrides: FaultProfileOverrides = {}): FaultProfile => {
  const profile: FaultProfile = { ...NO_FAULTS, ...overrides, latencyMs: { ...NO_FAULTS.latencyMs, ...overrides.latencyMs } };
  assertFaultProfile(profile);
  return profile;
};

export function assertFaultProfile(profile: FaultProfile): void {
  if (
    !Number.isSafeInteger(profile.latencyMs.min) ||
    !Number.isSafeInteger(profile.latencyMs.max) ||
    profile.latencyMs.min < 0 ||
    profile.latencyMs.min > profile.latencyMs.max
  ) {
    throw new FaultProfileError(`latencyMs must be an in-order non-negative integer range: ${JSON.stringify(profile.latencyMs)}`);
  }
  if (!Number.isSafeInteger(profile.staleAsOfMs) || profile.staleAsOfMs < 0) {
    throw new FaultProfileError(`staleAsOfMs must be a non-negative integer: ${profile.staleAsOfMs}`);
  }
  for (const key of RATE_KEYS) {
    const value = profile[key];
    if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
      throw new FaultProfileError(`${key} must be basis points 0..10000, got ${value}`);
    }
  }
}

export type Randomness = {
  nextUint32(): number;
  /** True `bps` ten-thousandths of the time. */
  chance(bps: number): boolean;
  /** Inclusive integer range, used for latency jitter. */
  range(min: number, max: number): number;
};

/** xorshift32: deterministic, dependency-free, and good enough to reproduce a failing run. */
export function createRandomness(seed: number): Randomness {
  if (!Number.isSafeInteger(seed) || seed === 0) {
    throw new FaultProfileError(`seed must be a non-zero safe integer, got ${seed}`);
  }
  let state = seed >>> 0;
  const nextUint32 = (): number => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
  return {
    nextUint32,
    chance: (bps: number) => nextUint32() % 10_000 < bps,
    range: (min: number, max: number) => min + (nextUint32() % (max - min + 1)),
  };
}

export type FaultInjector = {
  profile: FaultProfile;
  random: Randomness;
  /** Rolls one of the bps rates. Named so a call site reads as an intent, not a coin flip. */
  roll(key: (typeof RATE_KEYS)[number]): boolean;
  latencyMs(): number;
  /** The gateway's own view of "now": D13b says staleness is measured from here, not from our write. */
  asOf(now: Date): Date;
};

export function createFaultInjector(
  profile: FaultProfile = NO_FAULTS,
  seed: number = 1,
): FaultInjector {
  assertFaultProfile(profile);
  const random = createRandomness(seed);
  return {
    profile,
    random,
    roll: (key) => random.chance(profile[key]),
    latencyMs: () => random.range(profile.latencyMs.min, profile.latencyMs.max),
    asOf: (now) => new Date(now.getTime() - profile.staleAsOfMs),
  };
}
