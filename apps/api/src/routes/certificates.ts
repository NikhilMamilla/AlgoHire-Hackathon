import { Router } from 'express';
import { z } from 'zod';
import { audit } from '../audit.js';
import { currentUser, requireAuth, requireRole, userFromRequest } from '../auth.js';
import { renderCertificatePdf } from '../certificates/pdf.js';
import { verifyDownloadToken } from '../certificates/token.js';
import { HttpError } from '../errors.js';
import { ah, prisma } from '../lib.js';
import { publishBatch } from '../realtime.js';
import { batchScope } from '../scope.js';

export const certificatesRouter = Router();

const notFound = () => new HttpError(404, 'NOT_FOUND', 'Certificate not found');

/**
 * Exactly two ways in: the candidate's signed link (?token=) or a Bearer token for STATE or the owning CENTRE.
 * Everything else is 403. A revoked certificate is never served (410).
 */
certificatesRouter.get(
  '/certificates/:certNo/pdf',
  ah(async (req, res) => {
    const { certNo } = req.params;
    const cert = await prisma.certificate.findUnique({
      where: { certificateNo: certNo },
      include: { candidate: true, batch: { include: { centre: true } } },
    });
    if (!cert) throw notFound();

    const token = req.query.token;
    let allowed = typeof token === 'string' && verifyDownloadToken(certNo, token);
    if (!allowed && token === undefined) {
      const user = await userFromRequest(req);
      allowed = !!user && (user.role === 'STATE' || (user.role === 'CENTRE' && user.centreId === cert.batch.centreId));
    }
    if (!allowed) throw new HttpError(403, 'FORBIDDEN', 'Not allowed to download this certificate');
    if (cert.status === 'REVOKED') throw new HttpError(410, 'CERTIFICATE_REVOKED', 'This certificate has been revoked');

    const pdf = await renderCertificatePdf({
      certificateNo: cert.certificateNo,
      candidateName: cert.candidate.fullName,
      courseName: cert.batch.courseName,
      centreName: cert.batch.centre.name,
      completionDate: cert.candidate.completionDate,
      issuedAt: cert.issuedAt,
    });
    res
      .set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${cert.certificateNo}.pdf"`, 'Cache-Control': 'no-store' })
      .send(pdf);
  }),
);

/** Staff view: the certificate, its delivery and its audit timeline. Scoped through the batch (404 if not visible). */
certificatesRouter.get(
  '/certificates/:certNo',
  requireAuth,
  ah(async (req, res) => {
    const cert = await prisma.certificate.findFirst({
      where: { certificateNo: req.params.certNo, batch: batchScope(currentUser(req)) },
      include: {
        candidate: { select: { fullName: true, candidateRef: true, completionDate: true } },
        delivery: true,
        batch: { select: { id: true, courseName: true, status: true } },
      },
    });
    if (!cert) throw notFound();
    const audits = await prisma.auditLog.findMany({
      where: {
        OR: [
          { entityType: 'Certificate', entityId: cert.id },
          ...(cert.delivery ? [{ entityType: 'Delivery', entityId: cert.delivery.id }] : []),
        ],
      },
      orderBy: { id: 'asc' },
    });
    res.json({ certificate: { ...cert, audit: audits.map((a) => ({ ...a, id: a.id.toString() })) } });
  }),
);

/** STATE only. Never deletes: the row stays with revokedAt/revokedById/revokeReason. */
certificatesRouter.post(
  '/certificates/:certNo/revoke',
  requireAuth,
  requireRole('STATE'),
  ah(async (req, res) => {
    const user = currentUser(req);
    const { certNo } = req.params;
    const { reason } = z.object({ reason: z.string().trim().min(5).max(500) }).parse(req.body);
    const certificate = await prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<{ id: string; status: string }[]>`
        SELECT id, status FROM "Certificate" WHERE "certificateNo" = ${certNo} FOR UPDATE`;
      if (!locked) throw notFound();
      if (locked.status === 'REVOKED') throw new HttpError(409, 'ALREADY_REVOKED', 'Certificate is already revoked');

      const c = await tx.certificate.update({
        where: { id: locked.id },
        data: { status: 'REVOKED', revokedAt: new Date(), revokedById: user.id, revokeReason: reason },
        include: { batch: { select: { id: true, districtId: true, centreId: true } } },
      });
      await audit(tx, { actorId: user.id, action: 'CERTIFICATE_REVOKED', entityType: 'Certificate', entityId: c.id, metadata: { certificateNo: certNo, reason } });

      // Never send a revoked certificate: cancel a delivery that hasn't gone out (FAILED too, so retry-failed skips it).
      const delivery = await tx.delivery.findUnique({ where: { certificateId: c.id } });
      if (delivery && (delivery.status === 'PENDING' || delivery.status === 'FAILED')) {
        await tx.delivery.update({ where: { id: delivery.id }, data: { status: 'CANCELLED' } });
        await audit(tx, { actorId: user.id, action: 'DELIVERY_CANCELLED', entityType: 'Delivery', entityId: delivery.id, metadata: { reason: 'certificate revoked' } });
      }
      return c;
    });
    const { batch, ...cert } = certificate;
    await publishBatch('certificate.revoked', batch, { certificateNo: cert.certificateNo, status: 'REVOKED' });
    res.json({ certificate: cert });
  }),
);
