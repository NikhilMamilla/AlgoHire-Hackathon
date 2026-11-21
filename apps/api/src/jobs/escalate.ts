import { audit } from '../audit.js';
import { REVIEW } from '../batchWorkflow.js';
import { config } from '../config.js';
import { prisma } from '../lib.js';
import { publishBatch } from '../realtime.js';

const REVIEW_STATUSES = ['DISTRICT_REVIEW', 'QUALITY_REVIEW', 'STATE_REVIEW'] as const;

/**
 * SLA escalation (runs every 30s on `maintenance`). A batch waiting longer than SLA_MINUTES in a review stage
 * is escalated once: the conditional update (escalatedAt IS NULL, same status and stageEnteredAt) means two
 * workers, or two overlapping runs, can never escalate the same stage visit twice. moveTo clears escalatedAt
 * when the batch moves on, so each stage visit can be escalated at most once.
 */
export async function escalateStuckBatches(now = new Date()) {
  const cutoff = new Date(now.getTime() - config.slaMinutes * 60_000);
  const stuck = await prisma.batch.findMany({
    where: { status: { in: [...REVIEW_STATUSES] }, escalatedAt: null, stageEnteredAt: { lt: cutoff } },
    select: { id: true, status: true, stageEnteredAt: true, districtId: true, centreId: true },
  });

  let escalated = 0;
  for (const b of stuck) {
    const minutesWaiting = Math.floor((now.getTime() - b.stageEnteredAt!.getTime()) / 60_000);
    const won = await prisma.$transaction(async (tx) => {
      const { count } = await tx.batch.updateMany({
        where: { id: b.id, escalatedAt: null, status: b.status, stageEnteredAt: b.stageEnteredAt },
        data: { escalatedAt: now },
      });
      if (count) {
        await audit(tx, {
          actorId: null,
          action: 'BATCH_ESCALATED',
          entityType: 'Batch',
          entityId: b.id,
          metadata: { stage: REVIEW[b.status]!.stage, minutesWaiting, slaMinutes: config.slaMinutes },
        });
      }
      return count > 0;
    });
    if (won) {
      escalated++;
      await publishBatch('batch.escalated', b);
    }
  }
  return { escalated };
}
