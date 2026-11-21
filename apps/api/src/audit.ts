import type { Prisma } from '@prisma/client';

export type AuditAction =
  | 'BATCH_CREATED'
  | 'CSV_UPLOADED'
  | 'CSV_REJECTED'
  | 'BATCH_SUBMITTED'
  | 'BATCH_RESUBMITTED'
  | 'DECISION_RECORDED'
  | 'BATCH_STAGE_ADVANCED'
  | 'BATCH_RETURNED'
  | 'BATCH_REJECTED'
  | 'BATCH_APPROVED'
  | 'CERTIFICATES_ISSUED'
  | 'CERTIFICATE_DELIVERED'
  | 'DELIVERY_FAILED'
  | 'DELIVERY_CANCELLED'
  | 'DELIVERIES_REQUEUED'
  | 'CERTIFICATE_REVOKED';

/**
 * Pass the SAME transaction client as the business change, so the change and its
 * audit row commit or roll back together. AuditLog is append-only (DB trigger).
 */
export const audit = (
  tx: Prisma.TransactionClient,
  e: { actorId: string | null; action: AuditAction; entityType: string; entityId: string; metadata?: Prisma.InputJsonObject },
) => tx.auditLog.create({ data: { ...e, metadata: e.metadata ?? {} } });
