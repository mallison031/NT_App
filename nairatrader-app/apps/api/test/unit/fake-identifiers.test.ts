// The fakes' identifiers have to be unique across *processes*, not just within one. No gateway
// contract test can see this: the dev Postgres outlives the API process, so a second `pnpm start`
// that reissued `evt-1` would have its first webhook read as a duplicate of an event the database
// already closed, a reissued `chg_1` would be recorded onto the first order's payment row, and a
// reissued login would collide with the unique column D11 stores it in. All three are dedupe
// facts the fake itself has to respect, and they only show up after a restart.

import { describe, expect, it } from 'vitest';
import { koboFromString } from '@nt/shared';
import { FakePayments } from '../../src/gateways/fakes/fake-payments';
import { FakeTradingPlatform } from '../../src/gateways/fakes/fake-trading-platform';

async function chargeRef(fake: FakePayments, key: string): Promise<string> {
  const result = await fake.initCharge({
    idempotencyKey: key,
    orderId: 'ord_test_1',
    amountKobo: koboFromString('2500.00'),
    customerRef: 'cus_test_1',
  });
  if (!result.ok) throw new Error(`the fake refused its own charge: ${result.error}`);
  return result.value.data.providerRef;
}

const eventIdOf = (body: string): string => JSON.parse(body).id as string;

/** Provision through a fresh platform and return the login its ticket resolves to. */
async function loginFromNewProvision(fake: FakeTradingPlatform): Promise<string> {
  const ticket = await fake.requestProvision({
    idempotencyKey: 'idem-provision-1',
    userId: 'usr_test_1',
    productVersionId: 'prv_test_1',
    accountSizeKobo: 1_000_000n,
    platform: 'mt5',
  });
  if (!ticket.ok) throw new Error(`the fake refused its own provisioning: ${ticket.error}`);
  for (let read = 0; read < 5; read += 1) {
    const outcome = await fake.getProvision(ticket.value.data.id);
    if (!outcome.ok) throw new Error(`the fake lost its own ticket: ${outcome.error}`);
    if (outcome.value.data.state === 'SUCCEEDED') return outcome.value.data.login ?? 'no login';
  }
  throw new Error('the fake never resolved its own ticket');
}

describe('fake identifiers survive an API restart', () => {
  it('gives a second instance a charge reference the first one cannot answer for', async () => {
    const before = new FakePayments();
    const after = new FakePayments();
    const refBefore = await chargeRef(before, 'idem-a');

    const refAfter = await chargeRef(after, 'idem-b');
    expect(refAfter).not.toBe(refBefore);
    // The reference is what a confirmation read queries by, so a collision would let one process
    // answer for another process's money.
    expect(await after.getCharge(refBefore)).toMatchObject({ ok: false, error: 'permanent' });
  });

  it('gives a second instance an event id the database has not already closed', async () => {
    const before = new FakePayments();
    const after = new FakePayments();
    const refBefore = await chargeRef(before, 'idem-a');
    const refAfter = await chargeRef(after, 'idem-b');

    expect(eventIdOf(after.webhookFor(refAfter, 'completed').rawBody)).not.toBe(
      eventIdOf(before.webhookFor(refBefore, 'completed').rawBody),
    );
  });

  it('gives a second instance a login the platform would not hand out twice', async () => {
    expect(await loginFromNewProvision(new FakeTradingPlatform())).not.toBe(
      await loginFromNewProvision(new FakeTradingPlatform()),
    );
  });
});
