// PRD section 8: every money-moving and status-changing write is audit-logged. Reads are not;
// logging them is the over-engineering RISKS.md calls out, and it would put PII in the log for
// no benefit.
//
// The delegate is picked rather than the whole client so the same helper works inside a
// transaction: an audit row that survives while the change it describes rolls back is worse
// than no audit row.

import type { Prisma, PrismaClient } from '@prisma/client';

type Auditable = Pick<PrismaClient, 'auditLog'>;

export type AuditEntry = {
  actor: string;
  action: string;
  entity: string;
  entityId: string;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
};

export async function recordAudit(db: Auditable, entry: AuditEntry): Promise<void> {
  await db.auditLog.create({
    data: {
      actor: entry.actor,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId,
      before: entry.before,
      after: entry.after,
    },
  });
}
