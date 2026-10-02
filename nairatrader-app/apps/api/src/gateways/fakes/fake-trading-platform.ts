// FakeTradingPlatform (D13g): a stand-in for the MT5 layer that behaves like an integration we
// have not seen yet. It holds accounts in the *platform's own vocabulary*, maps them onto
// internal enums through the same helper a real adapter will use, builds the Account State
// Contract wire form, and runs it through the shared parser — so it cannot drift into emitting
// something the seam would reject.
//
// The status and phase spellings below are invented for the fake. The real ones come from
// docs/payload-spike.md, and the real adapter brings its own table (D13e). Never copy these
// into an adapter as if they were MT5 values.

import { randomInt } from 'node:crypto';
import {
  type AccountState,
  type AccountStateWire,
  ACCOUNT_STATE_CONTRACT_VERSION,
  type AccountStatus,
  koboToString,
  parseAccountState,
  type Phase,
} from '@nt/shared';
import { mapExternalEnum, type EnumMapping } from '../normalize';
import type {
  GatewayError,
  ProvisionOutcome,
  ProvisionReq,
  ResetOutcome,
  ResetReq,
  Result,
  Sourced,
  Ticket,
  Trade,
  TradePage,
  TradeQuery,
  TradingPlatformGateway,
} from '../types';
import {
  beforeCall,
  failure,
  type FakeOptions,
  type QueuedFault,
  resolveOptions,
  rollFailure,
  succeed,
} from './shared';

const SOURCE = 'fake_trading_platform';

const STATUS_TABLE: EnumMapping<AccountStatus> = {
  PROVISIONING: 'PENDING_PROVISION',
  ACTIVE: 'EVALUATION',
  PASSED: 'PASSED_AWAITING_UPGRADE',
  LIVE: 'FUNDED',
  STOPPED: 'BREACHED',
  CLOSED: 'CLOSED',
};

const PHASE_TABLE: EnumMapping<Phase> = {
  PREP: 'EVAL_1',
  E1: 'EVAL_1',
  E2: 'EVAL_2',
  E3: 'EVAL_3',
  LIVE: 'FUNDED',
};

/** Values with no entry in either table: what a platform sends after an unannounced change. */
const UNMAPPED_STATUS = 'LIQUIDATED_BY_RISK_DESK';
const UNMAPPED_PHASE = 'EVAL_4';

export type FakeAccountRecord = {
  login: string;
  /** Platform-side spelling, mapped through STATUS_TABLE on the way out. */
  status: string;
  phase: string;
  /** Whole-naira decimal strings, as a platform reports them. The seam stores kobo. */
  balanceNaira: string;
  equityNaira: string;
  withdrawableNaira: string;
  profitTargetBps: number;
  drawdownLimitBps: number;
  drawdownUsedBps: number;
  drawdownTimezone: string;
  phaseDeadline: string | null;
};

type OperationRecord = {
  ticketId: string;
  idempotencyKey: string;
  login: string;
  reads: number;
};

type GateFault = { kind: GatewayError; detail: string; ref?: string };

const defaultAccount = (login: string): FakeAccountRecord => ({
  login,
  status: 'ACTIVE',
  phase: 'E1',
  balanceNaira: '1250000.00',
  equityNaira: '1248750.50',
  withdrawableNaira: '0.00',
  profitTargetBps: 3000,
  drawdownLimitBps: 1000,
  drawdownUsedBps: 120,
  drawdownTimezone: 'Africa/Lagos',
  phaseDeadline: '2026-06-30T23:59:59Z',
});

const omitField = (value: AccountStateWire, field: keyof AccountStateWire): Record<string, unknown> => {
  const copy: Record<string, unknown> = { ...value };
  delete copy[field];
  return copy;
};

export class FakeTradingPlatform implements TradingPlatformGateway {
  readonly #accounts = new Map<string, FakeAccountRecord>();
  readonly #trades = new Map<string, Trade[]>();
  readonly #tickets = new Map<string, OperationRecord>();
  readonly #provisionsByKey = new Map<string, OperationRecord>();
  readonly #resetsByKey = new Map<string, OperationRecord>();
  readonly #resolved: ReturnType<typeof resolveOptions>;

  #resolveAfterReads = 1;
  #contractVersion = ACCOUNT_STATE_CONTRACT_VERSION;
  #dropField: keyof AccountStateWire | null = null;
  #forceUnmapped = false;
  /**
   * Logins are unique in this app's database, and a real MT5 server does not reissue one. The
   * fake starts each process somewhere else in the same eight-digit range for the same reason, so
   * a second dev run cannot provision into a login the first run already wrote.
   */
  #nextLogin = 41_000_001 + randomInt(0, 9_000_000);
  #nextTicket = 1;
  #provisionWrites = 0;
  #resetWrites = 0;

  public constructor(options: FakeOptions = {}) {
    this.#resolved = resolveOptions(options);
  }

  // ---- test control surface -------------------------------------------------------------

  /** Every call in order, so "did the retry write twice?" is an assertion, not a hope. */
  public get calls(): readonly string[] {
    return this.#resolved.calls;
  }

  public get unmapped(): readonly { gateway: string; field: string; received: string }[] {
    return this.#resolved.unmapped;
  }

  /** How many times the platform actually created something, ignoring repeated requests. */
  public get provisionWrites(): number {
    return this.#provisionWrites;
  }

  public get resetWrites(): number {
    return this.#resetWrites;
  }

  public seedAccount(record: Partial<FakeAccountRecord> & { login: string }): void {
    this.#accounts.set(record.login, { ...defaultAccount(record.login), ...record });
  }

  public seedTrades(login: string, trades: Trade[]): void {
    this.#trades.set(login, [...trades]);
  }

  /** Arm a fault for exactly the next call. `ok` consumes the queue entry without failing. */
  public forceNext(kind: QueuedFault['kind'], detail = 'forced by test', ref?: string): void {
    this.#resolved.queue.push({ kind, detail, ref });
  }

  /** How many getProvision/getReset reads a ticket stays open for (D13d). */
  public resolveTicketsAfterReads(reads: number): void {
    this.#resolveAfterReads = reads;
  }

  /** Serve a contract version this build has never seen; the seam must reject it (D13a). */
  public serveContractVersion(version: number): void {
    this.#contractVersion = version;
  }

  /** Serve a payload missing a required field; the parser must reject it (D13b). */
  public dropContractField(field: keyof AccountStateWire | null): void {
    this.#dropField = field;
  }

  /**
   * Serve a status and phase this build has never seen, every time. The profile rate exists for
   * fuzzing; this exists so a contract test can name the case instead of winning a coin flip.
   */
  public serveUnmappedStatus(on: boolean): void {
    this.#forceUnmapped = on;
  }

  // ---- reads ----------------------------------------------------------------------------

  public async getAccountState(login: string): Promise<Result<Sourced<AccountState>, GatewayError>> {
    const gate = await this.#gate(`getAccountState:${login}`);
    if (gate) return failure(gate.kind, gate.detail, gate.ref);

    const account = this.#accounts.get(login);
    if (!account) return failure('permanent', `unknown login ${login}`);

    // D13e: an unmapped platform value becomes UNKNOWN and is reported. It never becomes a
    // guess, and it never blocks the read — holding the state is the caller's job.
    const unmappedThisRead = this.#forceUnmapped || this.#resolved.faults.roll('unknownEnumBps');
    const rawStatus = unmappedThisRead ? UNMAPPED_STATUS : account.status;
    const rawPhase = unmappedThisRead ? UNMAPPED_PHASE : account.phase;
    const status = mapExternalEnum({
      raw: rawStatus,
      table: STATUS_TABLE,
      unknownValue: 'UNKNOWN',
      gateway: SOURCE,
      field: 'status',
      onUnmapped: this.#resolved.reportUnmapped,
    });
    const phase = mapExternalEnum({
      raw: rawPhase,
      table: PHASE_TABLE,
      unknownValue: 'UNKNOWN',
      gateway: SOURCE,
      field: 'phase',
      onUnmapped: this.#resolved.reportUnmapped,
    });

    const asOf = this.#resolved.faults.asOf(this.#resolved.clock());
    const wire: AccountStateWire = {
      contractVersion: this.#contractVersion,
      login: account.login,
      status,
      phase,
      balanceKobo: account.balanceNaira,
      equityKobo: account.equityNaira,
      withdrawableKobo: account.withdrawableNaira,
      profitTargetBps: account.profitTargetBps,
      drawdownLimitBps: account.drawdownLimitBps,
      drawdownUsedBps: account.drawdownUsedBps,
      drawdownTimezone: account.drawdownTimezone,
      phaseDeadline: account.phaseDeadline,
      asOf: asOf.toISOString(),
      source: SOURCE,
    };
    const json = this.#dropField === null ? wire : omitField(wire, this.#dropField);

    // The same gate a real adapter runs: an unrecognised version or a hole in the payload
    // stops here, rather than becoming a half-believable account.
    const parsed = parseAccountState(json);
    if (!parsed.ok) {
      if (parsed.reason === 'unsupported_contract_version') {
        return failure('permanent', `unsupported contract version ${parsed.received}`);
      }
      return failure('permanent', `invalid account state payload: ${parsed.issues.join('; ')}`);
    }

    const complete = !this.#resolved.faults.roll('incompleteBps');
    return succeed(parsed.state, parsed.state.asOf, SOURCE, complete);
  }

  public async listTrades(query: TradeQuery): Promise<Result<Sourced<TradePage>, GatewayError>> {
    const gate = await this.#gate(`listTrades:${query.login}`);
    if (gate) return failure(gate.kind, gate.detail, gate.ref);

    // D13c: a missing capability is feature-off, never an error shown to a trader.
    if (this.#resolved.faults.roll('unsupportedBps')) {
      return failure('unsupported', 'trade history is not available on this platform build');
    }
    if (!this.#accounts.has(query.login)) return failure('permanent', `unknown login ${query.login}`);

    const all = this.#trades.get(query.login) ?? this.#generatedTrades(query.login);
    const offset = this.#parseCursor(query.cursor);
    if (offset === null) return failure('permanent', `invalid cursor ${query.cursor}`);

    const page = all.slice(offset, offset + query.limit);
    const nextCursor = offset + page.length < all.length ? String(offset + page.length) : null;
    // D13b: a page the platform could not finish stays marked incomplete, so it can never be
    // mistaken for a quiet zero-profit day.
    const complete = !this.#resolved.faults.roll('incompleteBps');
    return succeed(
      { trades: page, nextCursor },
      this.#resolved.faults.asOf(this.#resolved.clock()),
      SOURCE,
      complete,
    );
  }

  // ---- writes (D13c, D13d) ---------------------------------------------------------------

  public async requestProvision(req: ProvisionReq): Promise<Result<Sourced<Ticket>, GatewayError>> {
    return this.#requestWrite({
      operation: 'requestProvision',
      idempotencyKey: req.idempotencyKey,
      existing: this.#provisionsByKey.get(req.idempotencyKey),
      create: () => this.#createProvision(req),
    });
  }

  public async getProvision(ticketId: string): Promise<Result<Sourced<ProvisionOutcome>, GatewayError>> {
    return this.#readTicket<ProvisionOutcome>({
      ticketId,
      pending: () => ({ state: 'PENDING' }),
      completed: (record) => ({
        state: 'SUCCEEDED',
        login: record.login,
        credentialHandle: `mt5-credentials/${record.login}`,
      }),
    });
  }

  public async requestReset(req: ResetReq): Promise<Result<Sourced<Ticket>, GatewayError>> {
    return this.#requestWrite({
      operation: 'requestReset',
      idempotencyKey: req.idempotencyKey,
      existing: this.#resetsByKey.get(req.idempotencyKey),
      create: () => this.#createReset(req),
    });
  }

  public async getReset(ticketId: string): Promise<Result<Sourced<ResetOutcome>, GatewayError>> {
    return this.#readTicket<ResetOutcome>({
      ticketId,
      pending: () => ({ state: 'PENDING' }),
      completed: () => ({ state: 'SUCCEEDED', phaseDeadline: null }),
    });
  }

  // ---- internals -------------------------------------------------------------------------

  /** Latency, then the armed fault, then the profile's rates. Null means "proceed". */
  async #gate(operation: string): Promise<GateFault | null> {
    const { fault } = await beforeCall(this.#resolved, operation);
    if (fault) {
      return fault.kind === 'ok' ? null : { kind: fault.kind, detail: fault.detail ?? 'forced by test', ref: fault.ref };
    }
    const automatic = rollFailure(this.#resolved.faults);
    return automatic ? { kind: automatic, detail: `${operation}: injected fault` } : null;
  }

  #parseCursor(cursor: string | undefined): number | null {
    if (cursor === undefined) return 0;
    // A cursor is a page index, not money, so integer parsing here is not a D2 concern.
    if (!/^\d{1,9}$/.test(cursor)) return null;
    return parseInt(cursor, 10);
  }

  #now(): Date {
    return this.#resolved.faults.asOf(this.#resolved.clock());
  }

  async #readTicket<T>(input: {
    ticketId: string;
    pending: () => T;
    completed: (record: OperationRecord) => T;
  }): Promise<Result<Sourced<T>, GatewayError>> {
    const gate = await this.#gate(`getTicket:${input.ticketId}`);
    if (gate) return failure(gate.kind, gate.detail, gate.ref);

    const record = this.#tickets.get(input.ticketId);
    if (!record) return failure('permanent', `unknown ticket ${input.ticketId}`);
    record.reads += 1;
    if (record.reads <= this.#resolveAfterReads) {
      // Still open: the caller keeps the order in FULFILLING rather than guessing (D13d).
      return succeed(input.pending(), this.#now(), SOURCE);
    }
    return succeed(input.completed(record), this.#now(), SOURCE);
  }

  async #requestWrite(input: {
    operation: string;
    idempotencyKey: string;
    existing: OperationRecord | undefined;
    create: () => OperationRecord;
  }): Promise<Result<Sourced<Ticket>, GatewayError>> {
    const gate = await this.#gate(`${input.operation}:${input.idempotencyKey}`);

    // A replayed key returns the original ticket. This is what makes a "did it go through?"
    // retry harmless instead of provisioning a trader twice.
    if (input.existing) return succeed({ id: input.existing.ticketId }, this.#now(), SOURCE);

    if (gate) {
      // unknown_outcome is the fault that must land the write first: the platform did accept
      // the request, we simply lost the answer. Callers reconcile with the returned ticket.
      if (gate.kind === 'unknown_outcome') {
        const created = input.create();
        return failure('unknown_outcome', gate.detail, created.ticketId);
      }
      return failure(gate.kind, gate.detail, gate.ref);
    }

    if (this.#resolved.faults.roll('transientBps')) {
      return failure('transient', `${input.operation} refused before the platform saw it`);
    }
    if (this.#resolved.faults.roll('unknownOutcomeBps')) {
      const created = input.create();
      return failure('unknown_outcome', 'timed out after the platform accepted the request', created.ticketId);
    }

    const created = input.create();
    return succeed({ id: created.ticketId }, this.#now(), SOURCE);
  }

  #createProvision(req: ProvisionReq): OperationRecord {
    const existing = this.#provisionsByKey.get(req.idempotencyKey);
    if (existing) return existing;

    const login = String(this.#nextLogin++);
    const record = this.#openTicket(req.idempotencyKey, login);
    this.#provisionsByKey.set(req.idempotencyKey, record);
    this.#provisionWrites += 1;
    this.seedAccount({
      login,
      status: 'PROVISIONING',
      phase: 'PREP',
      // Seed the platform's account size through the money helper: never Number, never toFixed.
      balanceNaira: koboToString(req.accountSizeKobo),
      withdrawableNaira: '0.00',
    });
    return record;
  }

  #createReset(req: ResetReq): OperationRecord {
    const existing = this.#resetsByKey.get(req.idempotencyKey);
    if (existing) return existing;

    const record = this.#openTicket(req.idempotencyKey, req.login);
    this.#resetsByKey.set(req.idempotencyKey, record);
    this.#resetWrites += 1;

    const account = this.#accounts.get(req.login);
    if (account) {
      // A reset reopens the phase, so drawdown usage goes to zero. Whether the deadline
      // restarts and from which date is a platform/owner answer (VERIFY: Phase 6 spike).
      account.drawdownUsedBps = 0;
      account.phase = 'E1';
      account.status = 'ACTIVE';
    }
    return record;
  }

  #openTicket(idempotencyKey: string, login: string): OperationRecord {
    const record: OperationRecord = { ticketId: `tkt-${this.#nextTicket++}`, idempotencyKey, login, reads: 0 };
    this.#tickets.set(record.ticketId, record);
    return record;
  }

  #generatedTrades(login: string): Trade[] {
    const base = Date.parse('2026-04-01T09:00:00Z');
    return Array.from({ length: 3 }, (_, index) => ({
      platformTradeId: `${login}-${index + 1}`,
      login,
      symbol: 'USDNGN',
      openedAt: new Date(base + index * 3_600_000),
      closedAt: new Date(base + index * 3_600_000 + 1_800_000),
      profitKobo: BigInt(index + 1) * 2_500_000n,
      lots: '0.10',
    }));
  }
}
