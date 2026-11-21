import { audit } from '../audit.js';
import { lockBatch, moveTo } from '../batchWorkflow.js';
import { newCertificateNo } from '../certificates/numbers.js';
import { HttpError } from '../errors.js';
import { logger, prisma } from '../lib.js';
import { enqueueDeliveries } from '../queues.js';
import { publishBatch } from '../realtime.js';

const MAX_NUMBER_TRIES = 5;

/**
 * Idempotent: safe to run any number of times, concurrently. The batch row lock serialises runs, an
 * ISSUED batch returns immediately, and unique candidateId / certificateId make duplicates impossible.
 * Issuance never depends on WhatsApp: deliveries are only enqueued after the commit.
 */
export async function issueCertificates(batchId: string, opts: { jobAttempt?: number } = {}) {
  const result = await prisma.$transaction(
    async (tx) => {
      let b;
      try {
        b = await lockBatch(tx, batchId);
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) return logger.warn({ batchId }, 'issue: batch not found'), null;
        throw e;
      }
      if (b.status === 'ISSUED') return null;
      if (b.status !== 'APPROVED') return logger.warn({ batchId, status: b.status }, 'issue: batch not APPROVED, skipping'), null;

      // skipDuplicates also silently skips a certificateNo collision, so re-check and retry until every
      // candidate has exactly one certificate.
      for (let attempt = 0; ; attempt++) {
        const missing = await tx.candidate.findMany({ where: { batchId, certificate: { is: null } }, select: { id: true } });
        if (!missing.length) break;
        if (attempt >= MAX_NUMBER_TRIES) throw new Error(`could not allocate certificate numbers for ${missing.length} candidates`);
        await tx.certificate.createMany({
          data: missing.map((c) => ({ batchId, candidateId: c.id, certificateNo: newCertificateNo() })),
          skipDuplicates: true,
        });
      }

      const certs = await tx.certificate.findMany({ where: { batchId }, select: { id: true } });
      await tx.delivery.createMany({ data: certs.map((c) => ({ certificateId: c.id })), skipDuplicates: true });
      const issued = await moveTo(tx, b, 'ISSUED');
      await audit(tx, {
        actorId: null,
        action: 'CERTIFICATES_ISSUED',
        entityType: 'Batch',
        entityId: batchId,
        metadata: { count: certs.length, jobAttempt: opts.jobAttempt ?? null },
      });
      const deliveries = await tx.delivery.findMany({ where: { certificate: { batchId }, status: 'PENDING' }, select: { id: true } });
      return { count: certs.length, deliveryIds: deliveries.map((d) => d.id), batch: issued };
    },
    { timeout: 30_000 },
  );

  if (!result) return null;
  await publishBatch('certificates.issued', result.batch);
  await enqueueDeliveries(result.deliveryIds);
  return { count: result.count, deliveryIds: result.deliveryIds };
}
