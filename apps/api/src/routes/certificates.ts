import { Router } from 'express';
import { userFromRequest } from '../auth.js';
import { renderCertificatePdf } from '../certificates/pdf.js';
import { verifyDownloadToken } from '../certificates/token.js';
import { HttpError } from '../errors.js';
import { ah, prisma } from '../lib.js';

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
