import { prisma } from '../lib.js';
import { enqueueDeliveries, enqueueIssue } from '../queues.js';

export const STALE_APPROVED_MS = 30_000;
export const STALE_DELIVERY_MS = 2 * 60_000;

/**
 * Runs every 30s on the `maintenance` queue. It re-enqueues work that the DB says is unfinished but that
 * may have no job: a crash between the DB commit and the enqueue, or Redis losing data.
 *  1. APPROVED batches whose stageEnteredAt is older than 30s (issuance never ran or never finished).
 *  2. PENDING deliveries not updated for 2+ minutes (each attempt bumps updatedAt, so these have no live job).
 * Re-enqueueing a job that is in fact still alive is harmless: issuance locks the batch row and returns if it
 * is already ISSUED, and delivery returns if SENT and sends with idempotencyKey = delivery id, so a duplicate
 * job can never create a second certificate or message. Job ids carry a 30s bucket so a previously
 * completed/failed job with the same id (kept by removeOnComplete/removeOnFail) does not block the re-run.
 */
export async function reconcile(now = Date.now()) {
  const bucket = Math.floor(now / 30_000);
  const batches = await prisma.batch.findMany({
    where: { status: 'APPROVED', stageEnteredAt: { lt: new Date(now - STALE_APPROVED_MS) } },
    select: { id: true },
  });
  const deliveries = await prisma.delivery.findMany({
    where: { status: 'PENDING', updatedAt: { lt: new Date(now - STALE_DELIVERY_MS) } },
    select: { id: true },
    take: 1000,
  });
  for (const b of batches) await enqueueIssue(b.id, `reissue-${b.id}-${bucket}`);
  await enqueueDeliveries(deliveries.map((d) => d.id), `redeliver-${bucket}`);
  return { batches: batches.length, deliveries: deliveries.length };
}
