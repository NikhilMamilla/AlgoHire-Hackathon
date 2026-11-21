import { BatchStatus } from '@prisma/client';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { audit } from '../audit.js';
import { currentUser, requireAuth, requireRole } from '../auth.js';
import { decide, EDITABLE, lockBatch, submitBatch } from '../batchWorkflow.js';
import { parseCandidatesCsv } from '../csv.js';
import { HttpError } from '../errors.js';
import { ah, prisma } from '../lib.js';
import { publishBatch } from '../realtime.js';
import { assertVisible, batchNotFound, batchScope } from '../scope.js';

export const batchesRouter = Router();
batchesRouter.use('/batches', requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024, files: 1 } });

export const maskPhone = (phone: string) => `******${phone.slice(-4)}`;

const STAGE_OF: Partial<Record<BatchStatus, string>> = { DISTRICT_REVIEW: 'DISTRICT', QUALITY_REVIEW: 'QUALITY', STATE_REVIEW: 'STATE' };

batchesRouter.post(
  '/batches',
  requireRole('CENTRE'),
  ah(async (req, res) => {
    const user = currentUser(req);
    const { courseName } = z.object({ courseName: z.string().trim().min(2).max(200) }).parse(req.body);
    // centre and district come from the logged-in user, never from the body.
    const centre = user.centreId ? await prisma.centre.findUnique({ where: { id: user.centreId } }) : null;
    if (!centre) throw new HttpError(403, 'FORBIDDEN', 'Your account is not linked to a centre');
    const batch = await prisma.$transaction(async (tx) => {
      const b = await tx.batch.create({ data: { courseName, centreId: centre.id, districtId: centre.districtId, createdById: user.id } });
      await audit(tx, { actorId: user.id, action: 'BATCH_CREATED', entityType: 'Batch', entityId: b.id, metadata: { courseName } });
      return b;
    });
    await publishBatch('batch.created', batch);
    res.status(201).json({ batch });
  }),
);

batchesRouter.get(
  '/batches',
  ah(async (req, res) => {
    const user = currentUser(req);
    const q = z
      .object({ status: z.nativeEnum(BatchStatus).optional(), escalated: z.enum(['true', 'false']).optional() })
      .parse(req.query);
    if (q.escalated && user.role !== 'STATE') throw new HttpError(403, 'FORBIDDEN', 'Only STATE can filter escalated batches');
    const batches = await prisma.batch.findMany({
      where: {
        AND: [
          batchScope(user),
          q.status ? { status: q.status } : {},
          // escalatedAt is cleared on every stage change, so non-null means "stuck in the current stage".
          q.escalated === 'true' ? { escalatedAt: { not: null } } : {},
        ],
      },
      include: {
        _count: { select: { candidates: true } },
        centre: { select: { name: true } },
        decisions: { select: { stage: true, round: true, type: true, actorId: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({
      batches: batches.map(({ _count, decisions, ...b }) => {
        const current = decisions.filter((d) => d.round === b.round && d.stage === STAGE_OF[b.status]);
        return {
          ...b,
          candidateCount: _count.candidates,
          approvals: current.filter((d) => d.type === 'APPROVE').length,
          decidedByMe: current.some((d) => d.actorId === user.id),
        };
      }),
    });
  }),
);

batchesRouter.get(
  '/batches/:id',
  ah(async (req, res) => {
    const user = currentUser(req);
    const batch = await prisma.batch.findFirst({
      where: { AND: [{ id: req.params.id }, batchScope(user)] },
      include: {
        centre: { select: { id: true, name: true } },
        district: { select: { name: true } },
        candidates: { orderBy: { candidateRef: 'asc' } },
        decisions: { include: { actor: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' } },
      },
    });
    if (!batch) throw batchNotFound();
    const audits = await prisma.auditLog.findMany({ where: { entityType: 'Batch', entityId: batch.id }, orderBy: { id: 'asc' } });
    const actorIds = [...new Set(audits.map((a) => a.actorId).filter((id): id is string => !!id))];
    const names = new Map((await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    // Data minimisation: only the owning centre (the only CENTRE that can see this batch) gets full phone numbers.
    const candidates = user.role === 'CENTRE' ? batch.candidates : batch.candidates.map((c) => ({ ...c, phone: maskPhone(c.phone) }));
    res.json({
      batch: {
        ...batch,
        candidates,
        audit: audits.map((a) => ({ ...a, id: a.id.toString(), actorName: a.actorId ? (names.get(a.actorId) ?? null) : null })),
      },
    });
  }),
);

batchesRouter.post(
  '/batches/:id/candidates/csv',
  requireRole('CENTRE'),
  upload.single('file'),
  ah(async (req, res) => {
    const user = currentUser(req);
    const batchId = req.params.id;
    if (!req.file) throw new HttpError(400, 'VALIDATION_ERROR', 'Attach the CSV as multipart field "file"');
    const current = await prisma.batch.findFirst({
      where: { AND: [{ id: batchId }, batchScope(user)] },
      select: { id: true, status: true, districtId: true, centreId: true },
    });
    if (!current) throw batchNotFound();
    if (!EDITABLE.includes(current.status)) throw new HttpError(409, 'INVALID_STATE', `Cannot upload candidates in ${current.status}`);

    const { rows, errors } = parseCandidatesCsv(req.file.buffer);
    if (errors.length) {
      // Nothing touches Candidate; only the rejection is audited, in its own small transaction.
      await prisma.$transaction((tx) =>
        audit(tx, { actorId: user.id, action: 'CSV_REJECTED', entityType: 'Batch', entityId: batchId, metadata: { errorCount: errors.length } }),
      );
      throw new HttpError(422, 'CSV_INVALID', `CSV has ${errors.length} error(s)`, { errors });
    }

    // Replace semantics: the CSV is the source of truth for the batch's candidates.
    await prisma.$transaction(async (tx) => {
      const b = await lockBatch(tx, batchId);
      await assertVisible(tx, user, batchId);
      if (!EDITABLE.includes(b.status)) throw new HttpError(409, 'INVALID_STATE', `Cannot upload candidates in ${b.status}`);
      await tx.candidate.deleteMany({ where: { batchId } });
      await tx.candidate.createMany({ data: rows.map((r) => ({ ...r, batchId })) });
      await audit(tx, { actorId: user.id, action: 'CSV_UPLOADED', entityType: 'Batch', entityId: batchId, metadata: { rowCount: rows.length } });
    });
    await publishBatch('batch.candidates', current);
    res.json({ count: rows.length });
  }),
);

batchesRouter.post(
  '/batches/:id/submit',
  requireRole('CENTRE'),
  ah(async (req, res) => {
    res.json({ batch: await submitBatch(currentUser(req), req.params.id) });
  }),
);

const decisionBody = z
  .object({ type: z.enum(['APPROVE', 'REJECT', 'RETURN']), reason: z.string().trim().max(1000).optional() })
  .refine((d) => d.type === 'APPROVE' || (d.reason?.length ?? 0) >= 5, {
    message: 'reason (at least 5 characters) is required to reject or return',
    path: ['reason'],
  });

batchesRouter.post(
  '/batches/:id/decisions',
  requireRole('DISTRICT_OFFICER', 'QUALITY', 'STATE'),
  ah(async (req, res) => {
    const { type, reason } = decisionBody.parse(req.body);
    res.status(201).json(await decide(currentUser(req), req.params.id, type, reason));
  }),
);

batchesRouter.get(
  '/batches/:id/certificates',
  ah(async (req, res) => {
    await assertVisible(prisma, currentUser(req), req.params.id);
    const certificates = await prisma.certificate.findMany({
      where: { batchId: req.params.id },
      include: {
        candidate: { select: { fullName: true, candidateRef: true } },
        delivery: { select: { status: true, attempts: true, lastError: true, updatedAt: true } },
      },
      orderBy: { candidate: { candidateRef: 'asc' } },
    });
    res.json({ certificates });
  }),
);
