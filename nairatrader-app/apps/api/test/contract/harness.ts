// The contract suite (D13g) talks to gateways through these harnesses, never to a concrete
// class. A harness says: "give me a gateway that reports data 11 minutes stale", "make the next
// call fail as unknown_outcome", "how many things did you really create downstream?".
//
// That vocabulary is deliberately implementation-independent, so the same suite can run against
// the real adapters once the Phase 6 spike provides a sandbox. A real harness will do the harder
// work of arranging those conditions upstream; if it cannot, that is information about the
// platform, not about the test.

import type { AccountStateWire, Kobo } from '@nt/shared';
import type { FaultProfile } from '../../src/gateways/fault-profile';
import type { UnmappedValue } from '../../src/gateways/normalize';
import type {
  GatewayError,
  IdentityGateway,
  PaymentsGateway,
  Trade,
  TradingPlatformGateway,
  WebhookInput,
} from '../../src/gateways/types';

export type ContractSetup = {
  /** Passed straight to the gateway under test. */
  profile?: FaultProfile;
  /** How far behind now the gateway reports its data (D13b staleness). */
  staleAsOfMs?: number;
  /** Reproducible fault RNG seed. */
  seed?: number;
  /** Shared clock, so expiry and staleness are asserted rather than raced. */
  clock?: () => Date;
};

export type TradingPlatformHarness = {
  gateway: TradingPlatformGateway;
  /** A login the gateway is known to hold, seeded and ready to read. */
  login(): string;
  /** Arm the next call. `ok` consumes the arm without failing. */
  arm(kind: GatewayError | 'ok'): void;
  /** Report a status outside the adapter's mapping table (D13e). */
  serveUnmappedStatus(): void;
  /** Serve a contract version this build has never seen (D13a). */
  serveContractVersion(version: number): void;
  /** Serve a payload with a required field absent (D13a, D13b). */
  serveMissingField(field: keyof AccountStateWire): void;
  /** Make a ticket stay open for `reads` more polls (D13d). */
  ticketOpensForReads(reads: number): void;
  /** Trades to serve for a login, for pagination and provenance assertions. */
  seedTrades(login: string, trades: Trade[]): void;
  /** Values the adapter could not map, in order reported. */
  unmapped(): readonly UnmappedValue[];
  /** Accounts the platform really created, which a lost response must not inflate. */
  provisionWrites(): number;
  /** Resets the platform really applied. */
  resetWrites(): number;
};

export type IdentityHarness = {
  gateway: IdentityGateway;
  /** A user id the identity system knows. */
  userId(): string;
  /** A token that currently verifies. */
  token(): string;
  /** A token that expired before `clock()`. */
  expiredToken(): string;
  /** D9: upstream password reset revokes what this app handed out. */
  revokeSessions(userId: string): void;
  arm(kind: GatewayError | 'ok'): void;
};

export type PaymentsHarness = {
  gateway: PaymentsGateway;
  arm(kind: GatewayError | 'ok'): void;
  /** Start a charge and return its provider reference. */
  charge(input: { idempotencyKey: string; orderId: string; amountKobo: Kobo }): Promise<string>;
  /**
   * Deliver a provider webhook for that charge, as an inbound HTTP body would arrive.
   * `status` is the provider's own spelling, so a new one exercises the mapping gap.
   */
  deliverWebhook(providerRef: string, status: string): Promise<WebhookInput>;
  /** The same webhook body with a signature that no longer matches. */
  tamperSignature(input: WebhookInput): WebhookInput;
  /** A syntactically valid body the provider would never send. */
  foreignBody(): WebhookInput;
  unmapped(): readonly UnmappedValue[];
  /** Charges the processor really created. */
  chargeWrites(): number;
  /** Deliveries that were duplicates of an event already sent. */
  duplicateDeliveries(): number;
  /** Deliveries of an event older than one already delivered. */
  outOfOrderDeliveries(): number;
};

export type ContractGateways = {
  name: string;
  tradingPlatform(setup?: ContractSetup): TradingPlatformHarness;
  identity(setup?: ContractSetup): IdentityHarness;
  payments(setup?: ContractSetup): PaymentsHarness;
};
