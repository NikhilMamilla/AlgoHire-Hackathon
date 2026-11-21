import { Router } from 'express';
import { audit } from '../audit.js';
import { currentUser, requireAuth, requireRole } from '../auth.js';
import { ah, prisma } from '../lib.js';
import { enqueueDeliveries } from '../queues.js';
import { publish } from '../realtime.js';

export const deliveriesRouter = Router();

/** Outage recovery: re-queue every FAILED delivery (e.g. after WhatsApp comes back). */
deliveriesRouter.post(
  '/deliveries/retry-failed',
  requireAuth,
  requireRole('STATE'),
  ah(async (req, res) => {
    const user = currentUser(req);
    const ids = await prisma.$transaction(async (tx) => {
      const failed = await tx.delivery.findMany({ where: { status: 'FAILED', certificate: { status: 'VALID' } }, select: { id: true } });
      const ids = failed.map((d) => d.id);
      if (!ids.length) return ids;
      await tx.delivery.updateMany({ where: { id: { in: ids }, status: 'FAILED' }, data: { status: 'PENDING' } });
      await audit(tx, { actorId: user.id, action: 'DELIVERIES_REQUEUED', entityType: 'Delivery', entityId: 'retry-failed', metadata: { count: ids.length } });
      return ids;
    });
    // Unique job ids: the old failed jobs are still kept (removeOnFail) under their original ids.
    await enqueueDeliveries(ids, `retry-${Date.now()}`);
    // Spans batches: only STATE (who sees everything) receives an event with no centre/district.
    if (ids.length) await publish({ type: 'deliveries.requeued', districtId: '', centreId: '' });
    res.json({ requeued: ids.length });
  }),
);
