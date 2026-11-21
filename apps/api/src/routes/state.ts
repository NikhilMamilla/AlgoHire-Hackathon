import { Router } from 'express';
import { requireAuth, requireRole } from '../auth.js';
import { ah, prisma } from '../lib.js';
import { maskPhone } from './batches.js';

export const stateRouter = Router();
stateRouter.use(['/stats', '/dev'], requireAuth, requireRole('STATE'));

const countBy = <K extends string>(rows: { _count: { _all: number } }[], key: (r: never) => K) =>
  Object.fromEntries(rows.map((r) => [key(r as never), r._count._all]));

/** Real counts only. */
stateRouter.get(
  '/stats',
  ah(async (_req, res) => {
    const [batches, certificates, deliveries, escalated] = await Promise.all([
      prisma.batch.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.certificate.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.delivery.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.batch.count({ where: { escalatedAt: { not: null } } }),
    ]);
    const certs = countBy(certificates, (r: { status: string }) => r.status);
    res.json({
      batches: countBy(batches, (r: { status: string }) => r.status),
      certificates: { total: (certs.VALID ?? 0) + (certs.REVOKED ?? 0), valid: certs.VALID ?? 0, revoked: certs.REVOKED ?? 0 },
      deliveries: { PENDING: 0, SENT: 0, FAILED: 0, CANCELLED: 0, ...countBy(deliveries, (r: { status: string }) => r.status) },
      escalated,
    });
  }),
);

/** Demo: the simulated WhatsApp provider's outbox. Phone numbers masked to the last 4 digits. */
stateRouter.get(
  '/dev/outbox',
  ah(async (_req, res) => {
    const messages = await prisma.outboundMessage.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
    res.json({ messages: messages.map((m) => ({ id: m.id, to: maskPhone(m.to), body: m.body, providerMessageId: m.providerMessageId, createdAt: m.createdAt })) });
  }),
);
