import { BatchStatus } from '@prisma/client';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { audit } from '../audit.js';
import { currentUser, requireAuth, requireRole } from '../auth.js';
import { EDITABLE, lockBatch, submitBatch } from '../batchWorkflow.js';
import { parseCandidatesCsv } from '../csv.js';
import { HttpError } from '../errors.js';
import { ah, prisma } from '../lib.js';
import { assertVisible, batchNotFound, batchScope } from '../scope.js';

export const batchesRouter = Router();
batchesRouter.use('/batches', requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024, files: 1 } });

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
    res.status(201).json({ batch });
  }),
);

batchesRouter.get(
  '/batches',
  ah(async (req, res) => {
    const { status } = z.object({ status: z.nativeEnum(BatchStatus).optional() }).parse(req.query);
    const batches = await prisma.batch.findMany({
      where: { AND: [batchScope(currentUser(req)), status ? { status } : {}] },
      include: {
        _count: { select: { candidates: true } },
        decisions: { where: { type: 'APPROVE' }, select: { stage: true, round: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({
      batches: batches.map(({ _count, decisions, ...b }) => ({
        ...b,
        candidateCount: _count.candidates,
        approvals: decisions.filter((d) => d.round === b.round && d.stage === STAGE_OF[b.status]).length,
      })),
    });
  }),
);

batchesRouter.get(
  '/batches/:id',
  ah(async (req, res) => {
    const batch = await prisma.batch.findFirst({
      where: { AND: [{ id: req.params.id }, batchScope(currentUser(req))] },
      include: {
        candidates: { orderBy: { candidateRef: 'asc' } },
        decisions: { include: { actor: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' } },
      },
    });
    if (!batch) throw batchNotFound();
    const audits = await prisma.auditLog.findMany({ where: { entityType: 'Batch', entityId: batch.id }, orderBy: { id: 'asc' } });
    res.json({ batch: { ...batch, audit: audits.map((a) => ({ ...a, id: a.id.toString() })) } });
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
    const current = await prisma.batch.findFirst({ where: { AND: [{ id: batchId }, batchScope(user)] }, select: { status: true } });
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
