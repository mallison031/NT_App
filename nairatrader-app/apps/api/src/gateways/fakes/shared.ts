// Shared plumbing for the Fake gateways (D13g). Two ways to produce a fault:
//
//  * a FaultProfile with basis-point rates and a seeded RNG, for stress runs, and
//  * forceNext(), which arms a fault for exactly the next call.
//
// The second exists because a contract test has to be able to say "this call comes back
// unknown_outcome" and know it is testing that and not a coin flip.

import { createFaultInjector, type FaultInjector, type FaultProfile, NO_FAULTS } from '../fault-profile';
import type { UnmappedSink, UnmappedValue } from '../normalize';
import type { GatewayError, Result, Sourced } from '../types';

export type FakeOptions = {
  profile?: FaultProfile;
  /** Seed for the fault RNG. Same seed plus same call sequence reproduces a run exactly. */
  seed?: number;
  clock?: () => Date;
  sleeper?: (ms: number) => Promise<void>;
};

export type ResolvedFakeOptions = {
  faults: FaultInjector;
  clock: () => Date;
  sleep: (ms: number) => Promise<void>;
  unmapped: UnmappedValue[];
  reportUnmapped: UnmappedSink;
  queue: FaultQueue;
  /** Every call made, in order, as `getAccountState` / `requestProvision:abc123`. */
  calls: string[];
};

export type QueuedFault = {
  kind: GatewayError | 'ok';
  detail?: string;
  ref?: string;
};

export class FaultQueue {
  readonly #items: QueuedFault[] = [];

  public push(fault: QueuedFault): void {
    this.#items.push(fault);
  }

  public take(): QueuedFault | undefined {
    return this.#items.shift();
  }

  public get pending(): number {
    return this.#items.length;
  }
}

export const realSleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

export function resolveOptions(options: FakeOptions = {}): ResolvedFakeOptions {
  const unmapped: UnmappedValue[] = [];
  return {
    faults: createFaultInjector(options.profile ?? NO_FAULTS, options.seed ?? 1),
    clock: options.clock ?? (() => new Date()),
    sleep: options.sleeper ?? realSleep,
    unmapped,
    reportUnmapped: (event) => {
      unmapped.push(event);
    },
    queue: new FaultQueue(),
    calls: [],
  };
}

/** The result constructors call sites should use, so `ok` is never confused with data. */
export const succeed = <T>(data: T, asOf: Date, source: string, complete = true): Result<Sourced<T>, GatewayError> => ({
  ok: true,
  value: { data, asOf, source, complete },
});

export const failure = (
  kind: GatewayError,
  detail: string,
  ref?: string,
): Result<never, GatewayError> => (ref === undefined ? { ok: false, error: kind, detail } : { ok: false, error: kind, detail, ref });

/**
 * Applies the two behaviours every fake shares: simulated latency, the recorded call
 * sequence, and the armed fault queue. Returns the fault to report, or null when the call
 * should proceed (and then, after the write-side effect has happened, possibly with
 * unknown_outcome — see D13c in each fake).
 */
export async function beforeCall(
  resolved: ResolvedFakeOptions,
  operation: string,
): Promise<{ fault: QueuedFault | null }> {
  await resolved.sleep(resolved.faults.latencyMs());
  resolved.calls.push(operation);
  return { fault: resolved.queue.take() ?? null };
}

/** Rolls the profile's rate-based faults after the queue is exhausted. */
export function rollFailure(faults: FaultInjector): GatewayError | null {
  if (faults.roll('transientBps')) return 'transient';
  if (faults.roll('permanentBps')) return 'permanent';
  if (faults.roll('unsupportedBps')) return 'unsupported';
  return null;
}
