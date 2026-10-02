// D13e: the mapping helper is the one place a platform's vocabulary becomes ours, so the cases
// that a real integration hits by accident are tested here on purpose — a missing field, a
// numeric status code, a value that arrives with a different spelling, a key that would resolve
// off a prototype.

import { describe, expect, it } from 'vitest';
import { mapExternalEnum, type EnumMapping, type UnmappedValue } from '../../src/gateways/normalize';

type Status = 'EVALUATION' | 'FUNDED' | 'UNKNOWN';

const TABLE: EnumMapping<Status> = {
  ACTIVE: 'EVALUATION',
  LIVE: 'FUNDED',
  1: 'EVALUATION',
};

const collect = (): { events: UnmappedValue[]; sink: (event: UnmappedValue) => void } => {
  const events: UnmappedValue[] = [];
  return { events, sink: (event) => events.push(event) };
};

const map = (raw: unknown): { value: Status; events: UnmappedValue[] } => {
  const { events, sink } = collect();
  const value = mapExternalEnum({
    raw,
    table: TABLE,
    unknownValue: 'UNKNOWN',
    gateway: 'unit_test',
    field: 'status',
    onUnmapped: sink,
  });
  return { value, events };
};

describe('mapExternalEnum (D13e)', () => {
  it('maps a value the table knows and reports nothing', () => {
    const { value, events } = map('ACTIVE');
    expect(value).toBe('EVALUATION');
    expect(events).toEqual([]);
  });

  it('maps a numeric code, since a platform may send a status as an integer', () => {
    expect(map(1).value).toBe('EVALUATION');
  });

  it('holds an unmapped value instead of defaulting it to a plausible status', () => {
    const { value, events } = map('LIQUIDATED_BY_RISK_DESK');
    expect(value).toBe('UNKNOWN');
    expect(events).toEqual([{ gateway: 'unit_test', field: 'status', received: 'LIQUIDATED_BY_RISK_DESK' }]);
  });

  it('is case-sensitive on purpose: a spelling variant is a table bug to fix deliberately', () => {
    expect(map('active').value).toBe('UNKNOWN');
    expect(map('Live').value).toBe('UNKNOWN');
  });

  it('reports whitespace as its own miss rather than matching a trimmed entry', () => {
    expect(map('ACTIVE ').value).toBe('UNKNOWN');
  });

  it('calls an absent value (missing), not an empty string, so the alert reads correctly', () => {
    expect(map(null).events[0]?.received).toBe('(missing)');
    expect(map(undefined).events[0]?.received).toBe('(missing)');
  });

  it('names the type when a field arrives as the wrong kind of JSON', () => {
    expect(map({ state: 'ACTIVE' }).events[0]?.received).toBe('(object)');
    expect(map(true).events[0]?.received).toBe('(boolean)');
    expect(map(['ACTIVE']).events[0]?.received).toBe('(object)');
  });

  it('never resolves a key through the prototype chain', () => {
    // `Object.hasOwn`, not `in`: this is the case where a wire value could otherwise read as
    // a mapping and hand back Object.prototype.
    const outcome = map('__proto__');
    expect(outcome.value).toBe('UNKNOWN');
    expect(outcome.events[0]?.received).toBe('__proto__');
    expect(map('constructor').value).toBe('UNKNOWN');
    expect(map('toString').value).toBe('UNKNOWN');
  });

  it('reports every miss, in order, so a count of unmapped values is a real number (D13h)', () => {
    const { events, sink } = collect();
    for (const raw of ['NOPE', 'NOPE2', 'ACTIVE', null]) {
      mapExternalEnum({ raw, table: TABLE, unknownValue: 'UNKNOWN', gateway: 'g', field: 'f', onUnmapped: sink });
    }
    expect(events.map((event) => event.received)).toEqual(['NOPE', 'NOPE2', '(missing)']);
  });
});
