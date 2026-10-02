// D13e: normalize at the boundary. Adapters convert whatever the platform spells a value into
// our internal enum, and a value nobody has mapped becomes UNKNOWN with an alert — never a
// guess. Defaulting an unknown status to EVALUATION, or a breach reason to MAX_DRAWDOWN, is
// how a trader gets told they passed when the engine said otherwise.

export type UnmappedValue = {
  gateway: string;
  field: string;
  /** The exact wire value, stringified for the operator. Null-ish values report as '(missing)'. */
  received: string;
};

export type UnmappedSink = (event: UnmappedValue) => void;

const MISSING = '(missing)';

export type EnumMapping<T extends string> = Readonly<Record<string, T>>;

/**
 * Look `raw` up in a table the adapter owns. Returns the mapped value, or `unknownValue` for
 * anything absent from the table, and reports every miss so `gateway_unknown_mapping_total`
 * can count it (D13e) and D13h's production monitor can see it.
 *
 * Matching is exact and case-sensitive on purpose: a real-world spelling variant is a mapping
 * table bug to fix deliberately, not something to paper over by upper-casing here.
 */
export function mapExternalEnum<T extends string>(input: {
  raw: unknown;
  table: EnumMapping<T>;
  unknownValue: T;
  gateway: string;
  field: string;
  onUnmapped: UnmappedSink;
}): T {
  const { raw, table, unknownValue, gateway, field, onUnmapped } = input;

  if (raw === null || raw === undefined) {
    onUnmapped({ gateway, field, received: MISSING });
    return unknownValue;
  }
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    onUnmapped({ gateway, field, received: `(${typeof raw})` });
    return unknownValue;
  }

  const key = String(raw);
  // Object.hasOwn, not `in`: a platform value of "__proto__" must not resolve to a mapping.
  if (!Object.hasOwn(table, key)) {
    onUnmapped({ gateway, field, received: key });
    return unknownValue;
  }
  return table[key] ?? unknownValue;
}
