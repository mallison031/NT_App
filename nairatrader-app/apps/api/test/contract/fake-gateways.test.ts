// The Fake-backed runner for the gateway contract (D13g). This is the only file that knows the
// suite is talking to fakes: hand describeGatewayContract() a harness for a real adapter and the
// same tests judge that integration instead, with no edits to the suite itself.

import { type Kobo } from '@nt/shared';
import { NO_FAULTS, type FaultProfile, profileWith } from '../../src/gateways/fault-profile';
import { FakeIdentity } from '../../src/gateways/fakes/fake-identity';
import { FakePayments } from '../../src/gateways/fakes/fake-payments';
import { FakeTradingPlatform } from '../../src/gateways/fakes/fake-trading-platform';
import type { ChargeReq, WebhookInput } from '../../src/gateways/types';
import type {
  ContractGateways,
  ContractSetup,
  IdentityHarness,
  PaymentsHarness,
  TradingPlatformHarness,
} from './harness';
import { describeGatewayContract } from './gateway-contract';

/** Placeholder fixtures only. Hard rule 7: no real contact data or credentials in tests. */
const LOGIN = '70000001';
const USER_ID = 'usr_contract_1';
const FOREIGN_BODY = '{"health":"ok"}';

/**
 * staleAsOfMs is a profile setting, but a harness asks for it directly, because D13b makes
 * staleness a property of the read rather than of a fault roll.
 */
function profileFor(setup: ContractSetup): FaultProfile | undefined {
  if (setup.staleAsOfMs === undefined) return setup.profile;
  return profileWith({ ...(setup.profile ?? NO_FAULTS), staleAsOfMs: setup.staleAsOfMs });
}

function fakeTradingPlatform(setup: ContractSetup = {}): TradingPlatformHarness {
  const fake = new FakeTradingPlatform({ profile: profileFor(setup), seed: setup.seed, clock: setup.clock });
  fake.seedAccount({ login: LOGIN });
  return {
    gateway: fake,
    login: () => LOGIN,
    arm: (kind) => {
      fake.forceNext(kind);
    },
    serveUnmappedStatus: () => {
      fake.serveUnmappedStatus(true);
    },
    serveContractVersion: (version) => {
      fake.serveContractVersion(version);
    },
    serveMissingField: (field) => {
      fake.dropContractField(field);
    },
    ticketOpensForReads: (reads) => {
      fake.resolveTicketsAfterReads(reads);
    },
    seedTrades: (login, trades) => {
      fake.seedTrades(login, trades);
    },
    unmapped: () => fake.unmapped,
    provisionWrites: () => fake.provisionWrites,
    resetWrites: () => fake.resetWrites,
  };
}

function fakeIdentity(setup: ContractSetup = {}): IdentityHarness {
  const fake = new FakeIdentity({ profile: profileFor(setup), seed: setup.seed, clock: setup.clock });
  fake.seedUser({ userId: USER_ID, email: null, phone: null, displayName: 'Contract Trader' });
  const now = (setup.clock ?? (() => new Date()))();
  const live = fake.issueToken(USER_ID, new Date(now.getTime() + 60 * 60 * 1000));
  // Issued already in the past, so expiry is the gateway's judgement and not a race.
  const expired = fake.issueToken(USER_ID, new Date(now.getTime() - 1000));
  return {
    gateway: fake,
    userId: () => USER_ID,
    token: () => live,
    expiredToken: () => expired,
    revokeSessions: (userId) => {
      fake.revokeSessions(userId);
    },
    arm: (kind) => {
      fake.forceNext(kind);
    },
  };
}

/**
 * Arrange a charge and hand back the provider's reference for it. Under the hostile profile the
 * creating call can fail, so this retries the *same idempotency key* until a charge exists: the
 * harness is setting up a precondition here, and the suite's own tests are where retry policy
 * gets asserted. A lost response is reconciled through the reference it carries (D13c).
 */
async function createCharge(
  fake: FakePayments,
  input: { idempotencyKey: string; orderId: string; amountKobo: Kobo },
): Promise<string> {
  const request: ChargeReq = { ...input, customerRef: `cus_${input.orderId}` };
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const result = await fake.initCharge(request);
    if (result.ok) return result.value.data.providerRef;
    if (result.error === 'unknown_outcome' && result.ref !== undefined) return result.ref;
  }
  throw new Error(`harness could not create a charge for ${input.orderId}`);
}

/**
 * Corrupt the signed bytes instead of the header, so no harness has to know what a provider
 * names its signature. A body that no longer matches its signature must be refused (rule 4).
 */
function corruptBody(input: WebhookInput): WebhookInput {
  return { rawBody: `${input.rawBody} `, headers: input.headers };
}

function fakePayments(setup: ContractSetup = {}): PaymentsHarness {
  const fake = new FakePayments({ profile: profileFor(setup), seed: setup.seed, clock: setup.clock });
  return {
    gateway: fake,
    arm: (kind) => {
      fake.forceNext(kind);
    },
    charge: (input) => createCharge(fake, input),
    deliverWebhook: async (providerRef, status) => fake.webhookFor(providerRef, status),
    tamperSignature: (input) => corruptBody(input),
    // Correctly signed, and still not something a processor would POST about a charge.
    foreignBody: () => fake.signAsProvider(FOREIGN_BODY),
    unmapped: () => fake.unmapped,
    chargeWrites: () => fake.initCharges,
    duplicateDeliveries: () => fake.duplicateDeliveries,
    outOfOrderDeliveries: () => fake.outOfOrderDeliveries,
  };
}

export const fakeGateways: ContractGateways = {
  name: 'Fake gateways',
  tradingPlatform: fakeTradingPlatform,
  identity: fakeIdentity,
  payments: fakePayments,
};

describeGatewayContract(fakeGateways);
