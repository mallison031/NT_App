// D6: the composition root for the seam. Everything above this line depends on the three
// gateway *interfaces*; this is the only module that knows which implementation is in use.
//
// Real adapters deliberately do not exist yet. Choosing a real value therefore fails at boot
// with a message that says why, rather than quietly substituting a fake and letting a trader
// believe they are looking at the live platform (D13h puts the payload spike first).

import type { Env } from '../config/env';
import type { IdentityGateway, PaymentsGateway, TradingPlatformGateway } from './types';
import { FakeIdentity } from './fakes/fake-identity';
import { FakePayments } from './fakes/fake-payments';
import { FakeTradingPlatform } from './fakes/fake-trading-platform';

export type Gateways = {
  tradingPlatform: TradingPlatformGateway;
  identity: IdentityGateway;
  payments: PaymentsGateway;
};

/** The fakes accept a clock so a run can be reproduced; a real adapter will not need one. */
export function buildGateways(env: Env, clock?: () => Date): Gateways {
  return {
    tradingPlatform: buildTradingPlatform(env.TRADING_GATEWAY, clock),
    identity: buildIdentity(env.IDENTITY_GATEWAY, clock),
    payments: buildPayments(env.PAYMENTS_PROVIDER, clock),
  };
}

const notBuilt = (gateway: string, value: string): never => {
  throw new Error(
    `${gateway} implementation "${value}" is not built. The Phase 6 spike captures the real ` +
      `payload in docs/payload-spike.md and writes the adapter against it (D13h); until then set ` +
      `the value back to "fake" and run against the Fake gateway.`,
  );
};

function buildTradingPlatform(value: Env['TRADING_GATEWAY'], clock?: () => Date): TradingPlatformGateway {
  if (value === 'fake') return new FakeTradingPlatform({ clock });
  return notBuilt('trading platform', value);
}

function buildIdentity(value: Env['IDENTITY_GATEWAY'], clock?: () => Date): IdentityGateway {
  if (value === 'fake') return new FakeIdentity({ clock });
  return notBuilt('identity', value);
}

function buildPayments(value: Env['PAYMENTS_PROVIDER'], clock?: () => Date): PaymentsGateway {
  if (value === 'fake') return new FakePayments({ clock });
  return notBuilt('payments', value);
}
