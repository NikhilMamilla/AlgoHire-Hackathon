import { Router } from 'express';
import { CERT_NO } from '../certificates/numbers.js';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { ah, prisma } from '../lib.js';
import { fixedWindowLimit } from '../rateLimit.js';

export const publicRouter = Router();

// Certificate numbers carry 50 random bits, so they can't be enumerated; the limiter blunts bursts on top.
publicRouter.use('/public', fixedWindowLimit('public', () => config.publicRateLimit));

/** No auth. Always reads Postgres (never cached) so a revocation shows on the very next call. */
publicRouter.get(
  '/public/verify/:certNo',
  ah(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const certNo = req.params.certNo.toUpperCase(); // Crockford base32 is case-insensitive
    if (!CERT_NO.test(certNo)) throw new HttpError(400, 'INVALID_FORMAT', 'Certificate number must look like CF-XXXXXXXXXX');

    const c = await prisma.certificate.findUnique({
      where: { certificateNo: certNo },
      select: {
        status: true,
        certificateNo: true,
        issuedAt: true,
        revokedAt: true,
        candidate: { select: { fullName: true, completionDate: true } },
        batch: { select: { courseName: true, centre: { select: { name: true } } } },
      },
    });
    if (!c) return res.status(404).json({ status: 'INVALID' });

    // Exactly these fields: no phone, candidateRef, ids, revoke reason or batch details.
    res.json({
      status: c.status,
      certificateNo: c.certificateNo,
      candidateName: c.candidate.fullName,
      courseName: c.batch.courseName,
      centreName: c.batch.centre.name,
      completionDate: c.candidate.completionDate.toISOString().slice(0, 10),
      issuedAt: c.issuedAt.toISOString(),
      ...(c.status === 'REVOKED' && c.revokedAt ? { revokedAt: c.revokedAt.toISOString() } : {}),
    });
  }),
);
