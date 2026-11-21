// The batch state machine. Every Batch.status change goes through `moveTo` here; nothing else updates status.
import type { BatchStatus, Prisma, User } from '@prisma/client';
import { audit } from './audit.js';
import { HttpError } from './errors.js';
import { prisma } from './lib.js';
import { assertVisible, batchNotFound } from './scope.js';

export const TRANSITIONS: Record<BatchStatus, readonly BatchStatus[]> = {
  DRAFT: ['DISTRICT_REVIEW'],
  RETURNED: ['DISTRICT_REVIEW'],
  DISTRICT_REVIEW: ['QUALITY_REVIEW', 'STATE_REVIEW', 'RETURNED', 'REJECTED'],
  QUALITY_REVIEW: ['STATE_REVIEW', 'RETURNED', 'REJECTED'],
  STATE_REVIEW: ['APPROVED', 'RETURNED', 'REJECTED'],
  APPROVED: ['ISSUED'],
  ISSUED: [],
  REJECTED: [],
};

export const EDITABLE: readonly BatchStatus[] = ['DRAFT', 'RETURNED'];

type LockedBatch = { id: string; status: BatchStatus; round: number; districtId: string; centreId: string };

/** Row lock: serialises concurrent writers (decisions, uploads, submits) on one batch. */
export async function lockBatch(tx: Prisma.TransactionClient, id: string): Promise<LockedBatch> {
  const rows = await tx.$queryRaw<LockedBatch[]>`
    SELECT id, status, round, "districtId", "centreId" FROM "Batch" WHERE id = ${id} FOR UPDATE`;
  if (!rows[0]) throw batchNotFound();
  return rows[0];
}

export async function moveTo(tx: Prisma.TransactionClient, batch: LockedBatch, to: BatchStatus, data: { round?: number } = {}) {
  if (!TRANSITIONS[batch.status].includes(to)) {
    throw new HttpError(409, 'INVALID_STATE', `Cannot move batch from ${batch.status} to ${to}`);
  }
  return tx.batch.update({
    where: { id: batch.id },
    data: { ...data, status: to, stageEnteredAt: new Date(), escalatedAt: null, version: { increment: 1 } },
  });
}

/**
 * Submit (DRAFT) or resubmit (RETURNED) for district review.
 *
 * POLICY: approvals belong to a round. A resubmitted batch starts a new round (round + 1), so approvals
 * from earlier rounds no longer count and the batch needs fresh approvals, because the candidate data may
 * have changed since they were given. Old decisions are kept for the audit trail.
 */
export function submitBatch(user: User, batchId: string) {
  return prisma.$transaction(async (tx) => {
    const b = await lockBatch(tx, batchId);
    await assertVisible(tx, user, batchId);
    if (!EDITABLE.includes(b.status)) throw new HttpError(409, 'INVALID_STATE', `Cannot submit a batch in ${b.status}`);
    const candidateCount = await tx.candidate.count({ where: { batchId } });
    if (!candidateCount) throw new HttpError(422, 'NO_CANDIDATES', 'Upload at least one candidate before submitting');

    const resubmit = b.status === 'RETURNED';
    const batch = await moveTo(tx, b, 'DISTRICT_REVIEW', resubmit ? { round: b.round + 1 } : {});
    await audit(tx, {
      actorId: user.id,
      action: resubmit ? 'BATCH_RESUBMITTED' : 'BATCH_SUBMITTED',
      entityType: 'Batch',
      entityId: batchId,
      metadata: { from: b.status, to: batch.status, round: batch.round, candidateCount },
    });
    return batch;
  });
}
