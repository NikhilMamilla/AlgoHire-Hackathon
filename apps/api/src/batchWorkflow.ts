// The batch state machine. Every Batch.status change goes through `moveTo` here; nothing else updates status.
import { Prisma, type BatchStatus, type DecisionType, type Role, type Stage, type User } from '@prisma/client';
import { audit, type AuditAction } from './audit.js';
import { config } from './config.js';
import { HttpError } from './errors.js';
import { onBatchApproved } from './events.js';
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

/** Review stages: the stage and the role allowed to decide are derived from status, never sent by the client. */
export const REVIEW: Partial<Record<BatchStatus, { stage: Stage; role: Role }>> = {
  DISTRICT_REVIEW: { stage: 'DISTRICT', role: 'DISTRICT_OFFICER' },
  QUALITY_REVIEW: { stage: 'QUALITY', role: 'QUALITY' },
  STATE_REVIEW: { stage: 'STATE', role: 'STATE' },
};

const ACTION_FOR: Partial<Record<BatchStatus, AuditAction>> = {
  QUALITY_REVIEW: 'BATCH_STAGE_ADVANCED',
  STATE_REVIEW: 'BATCH_STAGE_ADVANCED',
  RETURNED: 'BATCH_RETURNED',
  REJECTED: 'BATCH_REJECTED',
  APPROVED: 'BATCH_APPROVED',
};

export const DISTRICT_APPROVALS_REQUIRED = 2;

const STAGE_ORDER: Record<Role, number> = { CENTRE: -1, DISTRICT_OFFICER: 0, QUALITY: 1, STATE: 2 };

export async function decide(user: User, batchId: string, type: DecisionType, reason?: string) {
  const result = await prisma.$transaction(async (tx) => {
    // 1. Lock the row so concurrent decisions on this batch run one at a time.
    const b = await lockBatch(tx, batchId);

    // 2. Re-check status and permission against the locked row.
    // Another district's batch is always 404, so its existence is not leaked.
    if (user.role === 'DISTRICT_OFFICER' && user.districtId !== b.districtId) throw batchNotFound();
    const review = REVIEW[b.status];
    if (!review) {
      await assertVisible(tx, user, batchId);
      throw new HttpError(409, 'INVALID_STATE', `Batch is ${b.status}; no decision is open`);
    }
    if (user.role !== review.role) {
      // The batch moved past this reviewer's stage (e.g. a 3rd officer after two approvals): a state conflict.
      if (STAGE_ORDER[user.role] < STAGE_ORDER[review.role]) {
        throw new HttpError(409, 'INVALID_STATE', `Batch is now ${b.status}; your stage is closed`);
      }
      throw new HttpError(403, 'FORBIDDEN', `Only ${review.role} can decide at the ${review.stage} stage`);
    }

    // 3. The unique (batchId, stage, round, actorId) constraint is the final guarantee against double-counting.
    let decision;
    try {
      decision = await tx.decision.create({ data: { batchId, stage: review.stage, round: b.round, actorId: user.id, type, reason } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new HttpError(409, 'ALREADY_DECIDED', 'You have already decided on this batch in this round');
      }
      throw e;
    }
    await audit(tx, {
      actorId: user.id,
      action: 'DECISION_RECORDED',
      entityType: 'Batch',
      entityId: batchId,
      metadata: { decisionId: decision.id, stage: review.stage, round: b.round, type, reason: reason ?? null },
    });

    // 4. Transition.
    let to: BatchStatus | null = null;
    if (type === 'REJECT') to = 'REJECTED';
    else if (type === 'RETURN') to = 'RETURNED';
    else if (review.stage === 'DISTRICT') {
      // One row per actor (unique constraint), so this counts distinct approving officers in this round.
      const approvals = await tx.decision.count({ where: { batchId, stage: 'DISTRICT', round: b.round, type: 'APPROVE' } });
      if (approvals >= DISTRICT_APPROVALS_REQUIRED) {
        const candidateCount = await tx.candidate.count({ where: { batchId } });
        to = candidateCount >= config.qualityThreshold ? 'QUALITY_REVIEW' : 'STATE_REVIEW';
      }
    } else to = review.stage === 'QUALITY' ? 'STATE_REVIEW' : 'APPROVED';

    if (!to) return { decision, batch: await tx.batch.findUniqueOrThrow({ where: { id: batchId } }) };

    // 5. Status change: moveTo sets stageEnteredAt, version+1, escalatedAt=null.
    const batch = await moveTo(tx, b, to);
    await audit(tx, {
      actorId: user.id,
      action: ACTION_FOR[to]!,
      entityType: 'Batch',
      entityId: batchId,
      metadata: { from: b.status, to, round: b.round, reason: reason ?? null },
    });
    return { decision, batch };
  });

  if (result.batch.status === 'APPROVED') await onBatchApproved(batchId);
  return result;
}
