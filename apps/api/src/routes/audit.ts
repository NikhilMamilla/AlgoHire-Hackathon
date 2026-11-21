import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../auth.js';
import { ah, prisma } from '../lib.js';

export const auditRouter = Router();

auditRouter.get(
  '/audit',
  requireAuth,
  requireRole('STATE'),
  ah(async (req, res) => {
    const q = z
      .object({ entityType: z.string().max(50).optional(), entityId: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(500).default(200) })
      .parse(req.query);
    const rows = await prisma.auditLog.findMany({
      where: { entityType: q.entityType, entityId: q.entityId },
      orderBy: { id: 'desc' },
      take: q.limit,
    });
    res.json({ audit: rows.map((a) => ({ ...a, id: a.id.toString() })) });
  }),
);
