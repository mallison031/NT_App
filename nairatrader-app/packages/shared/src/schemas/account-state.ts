// D13a + hard rule 5c: the Account State Contract is the only source account status and
// account numbers may come from. Nothing in the app or the BFF computes breach or pass (D1);
// this module is the boundary that makes that enforceable.

import { z } from 'zod';
import { ACCOUNT_STATUSES, AccountStatus, PHASES, Phase } from '../enums';
import { isKoboString, koboFromString, koboToString, type Kobo } from '../money';

/**
 * The contract version this build accepts (D13a). Raising it without the owning team
 * publishing the new shape is how a silent rule drift starts, so an unrecognised version is
 * rejected and alerted rather than parsed optimistically.
 */
export const ACCOUNT_STATE_CONTRACT_VERSION = 1;
export const SUPPORTED_CONTRACT_VERSIONS: readonly number[] = [ACCOUNT_STATE_CONTRACT_VERSION];

// D13a says UTC ISO. Only the 'Z' form is accepted: an offset-bearing timestamp would let the
// daily-drawdown reset be interpreted two ways, which is exactly the dispute PRD section 6
// leaves open.
const UTC_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

const isRealUtcInstant = (value: string): boolean => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  // JS rolls 2026-02-31 over into March instead of failing to parse, so compare the date
  // part: a payload carrying an impossible day is a producer bug, not something to store.
  return date.toISOString().slice(0, 10) === value.slice(0, 10);
};

/**
 * The project-wide UTC timestamp schema (D13a): only the 'Z' form, and only dates that exist.
 * Exported so gateway payload schemas reuse the same rule instead of re-writing it.
 */
export const UtcIsoString = z
  .string()
  .regex(UTC_ISO_PATTERN, 'must be UTC ISO 8601, e.g. 2026-04-01T08:30:00Z')
  .refine(isRealUtcInstant, 'not a real date');

const koboField = z
  .string()
  .refine(isKoboString, 'must be a decimal kobo string with at most two fractional digits');

const bpsField = z.number().int().nonnegative();

/**
 * Wire shape: the 14 required fields of D13a, all mandatory. Unknown JSON keys are stripped
 * rather than rejected, because a producer adding a field must be caught by the version gate
 * and the shadow-mode diff, not by a brittle key check.
 * VERIFY: confirm tolerance against real payloads during the Phase 6 spike.
 */
const AccountStateWireSchema = z.object({
  contractVersion: z.number().int().nonnegative(),
  login: z.string().min(1).max(64),
  status: z.enum(ACCOUNT_STATUSES),
  phase: z.enum(PHASES),
  balanceKobo: koboField,
  equityKobo: koboField,
  withdrawableKobo: koboField,
  profitTargetBps: bpsField,
  drawdownLimitBps: bpsField,
  drawdownUsedBps: bpsField,
  // Owner-supplied definition (D13a): the timezone the engine resets daily drawdown in. This
  // build stores and displays it; it never re-interprets a timestamp using it.
  drawdownTimezone: z.string().min(1).max(64),
  phaseDeadline: UtcIsoString.nullable(),
  asOf: UtcIsoString,
  // Provenance: 'risk_engine', 'read_replica', 'mt5_bridge', ...
  source: z.string().min(1).max(64),
});

export type AccountStateWire = z.infer<typeof AccountStateWireSchema>;

/** Parsed contract: money is BigInt kobo, timestamps are Date (D2, D13e). */
export type AccountState = {
  contractVersion: number;
  login: string;
  status: AccountStatus;
  phase: Phase;
  balanceKobo: Kobo;
  equityKobo: Kobo;
  withdrawableKobo: Kobo;
  profitTargetBps: number;
  drawdownLimitBps: number;
  drawdownUsedBps: number;
  drawdownTimezone: string;
  phaseDeadline: Date | null;
  asOf: Date;
  source: string;
};

export type AccountStateParse =
  | { ok: true; state: AccountState }
  // Reported separately from a bad shape so the alert can say "new contract version" rather
  // than "malformed JSON" (D13a requires both to alert, but they page different people).
  | { ok: false; reason: 'unsupported_contract_version'; received: number }
  | { ok: false; reason: 'invalid_payload'; issues: string[] };

const VersionProbeSchema = z.object({ contractVersion: z.number().int().nonnegative() });

/** Parse an inbound contract payload. Never throws; the caller maps each reason to a failure. */
export function parseAccountState(json: unknown): AccountStateParse {
  const probe = VersionProbeSchema.safeParse(json);
  if (!probe.success) {
    return { ok: false, reason: 'invalid_payload', issues: formatIssues(probe.error) };
  }
  if (!SUPPORTED_CONTRACT_VERSIONS.includes(probe.data.contractVersion)) {
    return { ok: false, reason: 'unsupported_contract_version', received: probe.data.contractVersion };
  }

  const wire = AccountStateWireSchema.safeParse(json);
  if (!wire.success) {
    return { ok: false, reason: 'invalid_payload', issues: formatIssues(wire.error) };
  }

  const value = wire.data;
  return {
    ok: true,
    state: {
      contractVersion: value.contractVersion,
      login: value.login,
      status: value.status,
      phase: value.phase,
      balanceKobo: koboFromString(value.balanceKobo),
      equityKobo: koboFromString(value.equityKobo),
      withdrawableKobo: koboFromString(value.withdrawableKobo),
      profitTargetBps: value.profitTargetBps,
      drawdownLimitBps: value.drawdownLimitBps,
      drawdownUsedBps: value.drawdownUsedBps,
      drawdownTimezone: value.drawdownTimezone,
      phaseDeadline: value.phaseDeadline === null ? null : new Date(value.phaseDeadline),
      asOf: new Date(value.asOf),
      source: value.source,
    },
  };
}

/** JSON form for a response: kobo back to a decimal string, dates to UTC ISO (D2). */
export function accountStateToJson(state: AccountState): AccountStateWire {
  return {
    contractVersion: state.contractVersion,
    login: state.login,
    status: state.status,
    phase: state.phase,
    balanceKobo: koboToString(state.balanceKobo),
    equityKobo: koboToString(state.equityKobo),
    withdrawableKobo: koboToString(state.withdrawableKobo),
    profitTargetBps: state.profitTargetBps,
    drawdownLimitBps: state.drawdownLimitBps,
    drawdownUsedBps: state.drawdownUsedBps,
    drawdownTimezone: state.drawdownTimezone,
    phaseDeadline: state.phaseDeadline === null ? null : toUtcIso(state.phaseDeadline),
    asOf: toUtcIso(state.asOf),
    source: state.source,
  };
}

const toUtcIso = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

// D8 / F1 acceptance criterion: data older than five minutes must wear a stale badge.
export const STALE_AFTER_MS = 5 * 60 * 1000;

/**
 * A timestamp from the future is treated as stale too. The AC is "never show a fresh-looking
 * number without a badge", and a producer whose clock is ahead would otherwise pass as fresh.
 * VERIFY: a real skew allowance is an owner decision, not an engineering default.
 */
export function isStale(asOf: Date, now: Date, thresholdMs: number = STALE_AFTER_MS): boolean {
  const age = now.getTime() - asOf.getTime();
  return age > thresholdMs || age < 0;
}

/**
 * D13b + D13e: incomplete data and unmapped (UNKNOWN) values may never drive a state change.
 * The parameter is structural so a `Sourced<AccountState>` from the gateway can be spread in.
 */
export function canDriveStatusTransition(input: {
  status: AccountStatus;
  phase: Phase;
  complete: boolean;
}): boolean {
  return (
    input.complete && input.status !== AccountStatus.Unknown && input.phase !== Phase.Unknown
  );
}

/**
 * F1's "drawdown headroom", derived only from contract values. D1 allows displaying this and
 * labelling it estimated; it is not a breach judgement, and the UI must not present it as one.
 */
export const drawdownHeadroomBps = (state: Pick<AccountState, 'drawdownLimitBps' | 'drawdownUsedBps'>): number =>
  state.drawdownLimitBps - state.drawdownUsedBps;

const formatIssues = (error: z.ZodError): string[] =>
  error.issues.map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`);
