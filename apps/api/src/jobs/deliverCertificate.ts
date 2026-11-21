import { audit } from '../audit.js';
import { downloadToken } from '../certificates/token.js';
import { config } from '../config.js';
import { prisma } from '../lib.js';
import { publishBatch } from '../realtime.js';
import type { WhatsAppProvider } from '../whatsapp/provider.js';

export const SEND_TIMEOUT_MS = 3000;

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`provider timeout after ${ms}ms`)), ms))]);

/**
 * Sends one certificate over WhatsApp. Idempotent: SENT returns early, and the provider dedupes on
 * idempotencyKey = delivery.id, so a retry after "accepted but timed out" never sends a second message.
 * Errors are rethrown so BullMQ retries with backoff.
 */
export async function deliverCertificate(deliveryId: string, provider: WhatsAppProvider, opts: { timeoutMs?: number } = {}) {
  const d = await prisma.delivery.findUnique({
    where: { id: deliveryId },
    include: { certificate: { include: { candidate: true, batch: { select: { id: true, courseName: true, districtId: true, centreId: true } } } } },
  });
  if (!d || d.status === 'SENT') return 'SKIPPED' as const;

  const cert = d.certificate;
  if (d.status === 'CANCELLED' || cert.status === 'REVOKED') {
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.delivery.updateMany({ where: { id: d.id, status: { in: ['PENDING', 'FAILED'] } }, data: { status: 'CANCELLED' } });
      if (count) await audit(tx, { actorId: null, action: 'DELIVERY_CANCELLED', entityType: 'Delivery', entityId: d.id, metadata: { reason: 'certificate revoked' } });
    });
    await publishBatch('delivery.status', cert.batch, { certificateNo: cert.certificateNo, status: 'CANCELLED' });
    return 'CANCELLED' as const;
  }

  const firstName = cert.candidate.fullName.split(/\s+/)[0];
  const base = config.publicBaseUrl;
  const body = [
    `Hello ${firstName}, congratulations on completing ${cert.batch.courseName}!`,
    `Certificate No: ${cert.certificateNo}`,
    `Download: ${base}/api/certificates/${cert.certificateNo}/pdf?token=${downloadToken(cert.certificateNo)}`,
    `Verify: ${base}/verify/${cert.certificateNo}`,
  ].join('\n');

  try {
    const { providerMessageId } = await withTimeout(
      provider.send({ to: `+91${cert.candidate.phone}`, body, idempotencyKey: d.id }),
      opts.timeoutMs ?? SEND_TIMEOUT_MS,
    );
    // Conditional: if a revocation cancelled this delivery mid-send, keep CANCELLED (the message is in OutboundMessage).
    const sent = await prisma.$transaction(async (tx) => {
      const { count } = await tx.delivery.updateMany({
        where: { id: d.id, status: { in: ['PENDING', 'FAILED'] } },
        data: { status: 'SENT', providerMessageId, attempts: { increment: 1 }, lastError: null },
      });
      if (count) await audit(tx, { actorId: null, action: 'CERTIFICATE_DELIVERED', entityType: 'Delivery', entityId: d.id, metadata: { providerMessageId, attempt: d.attempts + 1 } });
      return count > 0;
    });
    const status = sent ? ('SENT' as const) : ('CANCELLED' as const);
    await publishBatch('delivery.status', cert.batch, { certificateNo: cert.certificateNo, status });
    return status;
  } catch (err) {
    await prisma.delivery.update({ where: { id: d.id }, data: { attempts: { increment: 1 }, lastError: (err as Error).message } });
    // Attempts/lastError changed: let staff screens tick live.
    await publishBatch('delivery.status', cert.batch, { certificateNo: cert.certificateNo, status: 'PENDING' });
    throw err;
  }
}

/** Called by the worker when a delivery job has used all its attempts. */
export async function markDeliveryFailed(deliveryId: string, reason: string) {
  const failed = await prisma.$transaction(async (tx) => {
    const { count } = await tx.delivery.updateMany({ where: { id: deliveryId, status: 'PENDING' }, data: { status: 'FAILED', lastError: reason } });
    if (count) await audit(tx, { actorId: null, action: 'DELIVERY_FAILED', entityType: 'Delivery', entityId: deliveryId, metadata: { reason } });
    return count > 0;
  });
  if (!failed) return;
  const d = await prisma.delivery.findUnique({
    where: { id: deliveryId },
    select: { certificate: { select: { certificateNo: true, batch: { select: { id: true, districtId: true, centreId: true } } } } },
  });
  if (d) await publishBatch('delivery.status', d.certificate.batch, { certificateNo: d.certificate.certificateNo, status: 'FAILED' });
}
