import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_STATE_CONTRACT_VERSION,
  accountStateToJson,
  type AccountState,
  type AccountStateWire,
  canDriveStatusTransition,
  drawdownHeadroomBps,
  isStale,
  parseAccountState,
  STALE_AFTER_MS,
} from '../src/schemas/account-state';

const wire = (): AccountStateWire => ({
  contractVersion: ACCOUNT_STATE_CONTRACT_VERSION,
  login: '41273902',
  status: 'EVALUATION',
  phase: 'EVAL_1',
  balanceKobo: '125000000.00',
  equityKobo: '124875000.50',
  withdrawableKobo: '0.00',
  profitTargetBps: 3000,
  drawdownLimitBps: 1000,
  drawdownUsedBps: 120,
  drawdownTimezone: 'Africa/Lagos',
  phaseDeadline: '2026-06-30T23:59:59Z',
  asOf: '2026-04-01T08:30:00Z',
  source: 'risk_engine',
});

const parsed = (): AccountState => {
  const result = parseAccountState(wire());
  if (!result.ok) throw new Error(`expected a valid payload, got ${JSON.stringify(result)}`);
  return result.state;
};

describe('Account State Contract parsing (D13a)', () => {
  it('parses every required field into BigInt kobo and Date', () => {
    const state = parsed();
    expect(state.balanceKobo).toBe(12_500_000_000n);
    expect(state.equityKobo).toBe(12_487_500_050n);
    expect(state.withdrawableKobo).toBe(0n);
    expect(state.asOf).toEqual(new Date('2026-04-01T08:30:00Z'));
    expect(state.phaseDeadline).toEqual(new Date('2026-06-30T23:59:59Z'));
    expect(state.drawdownTimezone).toBe('Africa/Lagos');
    expect(state.source).toBe('risk_engine');
  });

  it('accepts a null phase deadline (funded accounts have none)', () => {
    const result = parseAccountState({ ...wire(), phaseDeadline: null });
    expect(result.ok).toBe(true);
  });

  // All 14 are required by D13a, so a payload missing any one of them is not the contract.
  it.each(Object.keys(wire()))('rejects a payload missing %s', (field) => {
    const partial: Record<string, unknown> = { ...wire() };
    delete partial[field];
    const result = parseAccountState(partial);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'invalid_payload') {
      expect(result.issues.join(' ')).toContain(field);
    }
  });

  it('separates an unknown contract version from a malformed payload (both alert, differently)', () => {
    for (const version of [2, 0, 99, ACCOUNT_STATE_CONTRACT_VERSION + 1]) {
      const result = parseAccountState({ ...wire(), contractVersion: version });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('unsupported_contract_version');
        if (result.reason === 'unsupported_contract_version') expect(result.received).toBe(version);
      }
    }
  });

  it('does not call a missing version a version mismatch', () => {
    const partial: Record<string, unknown> = { ...wire() };
    delete partial.contractVersion;
    expect(parseAccountState(partial).ok).toBe(false);
    const result = parseAccountState(partial);
    if (!result.ok) expect(result.reason).toBe('invalid_payload');
  });

  it('refuses a non-UTC asOf instead of guessing the offset', () => {
    for (const asOf of ['2026-04-01T08:30:00+01:00', '2026-04-01T08:30:00', '2026-04-01 08:30:00Z']) {
      expect(parseAccountState({ ...wire(), asOf }).ok).toBe(false);
    }
  });

  it('refuses a date that does not exist', () => {
    expect(parseAccountState({ ...wire(), asOf: '2026-02-31T00:00:00Z' }).ok).toBe(false);
  });

  it('requires the wire money form, not a float or a bare number', () => {
    expect(parseAccountState({ ...wire(), balanceKobo: 125000000 }).ok).toBe(false);
    expect(parseAccountState({ ...wire(), balanceKobo: '125000000.005' }).ok).toBe(false);
    expect(parseAccountState({ ...wire(), equityKobo: '1.2e8' }).ok).toBe(false);
  });

  it('only accepts internal enum members, never raw external spellings', () => {
    // An adapter that forgot to map BREACH/WIN must fail here rather than store a guess (D13e).
    expect(parseAccountState({ ...wire(), status: 'BREACH' }).ok).toBe(false);
    expect(parseAccountState({ ...wire(), phase: 'STAGE_1' }).ok).toBe(false);
    expect(parseAccountState({ ...wire(), status: 'UNKNOWN', phase: 'UNKNOWN' }).ok).toBe(true);
  });

  it('ignores extra keys a newer producer might add', () => {
    const result = parseAccountState({ ...wire(), marginCallPct: 40 });
    expect(result.ok).toBe(true);
  });

  it('round-trips through JSON without changing any kobo', () => {
    const state = parsed();
    const json = accountStateToJson(state);
    expect(json.balanceKobo).toBe('125000000.00');
    expect(json.equityKobo).toBe('124875000.50');
    expect(json.asOf).toBe('2026-04-01T08:30:00Z');
    expect(parseAccountState(json)).toEqual({ ok: true, state });
  });
});

describe('staleness (D8, F1 acceptance criterion)', () => {
  const asOf = new Date('2026-04-01T08:30:00Z');
  const MINUTE = 60_000;

  it('uses the five minute threshold', () => {
    expect(STALE_AFTER_MS).toBe(5 * MINUTE);
    expect(isStale(asOf, new Date(asOf.getTime() + 4 * MINUTE))).toBe(false);
    expect(isStale(asOf, new Date(asOf.getTime() + 5 * MINUTE))).toBe(false);
    expect(isStale(asOf, new Date(asOf.getTime() + 5 * MINUTE + 1))).toBe(true);
  });

  it('treats a future timestamp as stale rather than fresh', () => {
    expect(isStale(asOf, new Date(asOf.getTime() - MINUTE))).toBe(true);
  });

  it('accepts a per-poll-class threshold (funded accounts poll at 5m)', () => {
    const fourMinutesAgo = new Date(asOf.getTime() + 4 * MINUTE);
    expect(isStale(asOf, fourMinutesAgo, 3 * MINUTE)).toBe(true);
  });
});

describe('status-transition guard (D13b, D13e)', () => {
  it('allows a transition only for complete, fully-mapped data', () => {
    expect(canDriveStatusTransition({ status: 'EVALUATION', phase: 'EVAL_1', complete: true })).toBe(true);
  });

  it('holds on incomplete data', () => {
    expect(canDriveStatusTransition({ status: 'FUNDED', phase: 'FUNDED', complete: false })).toBe(false);
  });

  it('holds on an unmapped status or phase', () => {
    expect(canDriveStatusTransition({ status: 'UNKNOWN', phase: 'EVAL_1', complete: true })).toBe(false);
    expect(canDriveStatusTransition({ status: 'EVALUATION', phase: 'UNKNOWN', complete: true })).toBe(false);
  });
});

describe('drawdown headroom (D1: estimated display only)', () => {
  it('subtracts contract values without judging breach', () => {
    expect(drawdownHeadroomBps({ drawdownLimitBps: 1000, drawdownUsedBps: 120 })).toBe(880);
    // Past the limit the engine still owns the verdict; the number just goes negative.
    expect(drawdownHeadroomBps({ drawdownLimitBps: 1000, drawdownUsedBps: 1400 })).toBe(-400);
  });
});
