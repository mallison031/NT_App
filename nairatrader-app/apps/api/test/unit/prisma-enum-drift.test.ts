import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_STATUSES,
  BREACH_REASONS,
  NOTIFICATION_TYPES,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  PAYOUT_STATUSES,
  PHASES,
  RESET_STATUSES,
  TICKET_STATUSES,
} from '@nt/shared';

const schema = readFileSync(
  fileURLToPath(new URL('../../prisma/schema.prisma', import.meta.url)),
  'utf8',
);

function prismaEnum(name: string): string[] {
  const block = new RegExp(`enum ${name} \\{([^}]*)\\}`).exec(schema);
  if (!block) throw new Error(`enum ${name} is missing from schema.prisma`);
  return (block[1] ?? '').split('\n').flatMap((line) => line.trim().split(/\s+/)).filter(Boolean);
}

// Order matters here: Prisma declares these in a fixed sequence and the app
// renders them in that sequence, so a reordering is a real change, not noise.
const contract: Array<[string, readonly string[]]> = [
  ['AccountStatus', ACCOUNT_STATUSES],
  ['Phase', PHASES],
  ['OrderStatus', ORDER_STATUSES],
  ['PaymentStatus', PAYMENT_STATUSES],
  ['PayoutStatus', PAYOUT_STATUSES],
  ['ResetStatus', RESET_STATUSES],
  ['TicketStatus', TICKET_STATUSES],
  ['BreachReason', BREACH_REASONS],
  ['NotificationType', NOTIFICATION_TYPES],
];

describe('schema.prisma enums and @nt/shared stay in lockstep', () => {
  it.each(contract)('%s', (name, sharedValues) => {
    expect(prismaEnum(name)).toEqual([...sharedValues]);
  });
});
