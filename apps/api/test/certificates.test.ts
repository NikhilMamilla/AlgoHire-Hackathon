import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { downloadToken } from '../src/certificates/token.js';
import { deliverCertificate, markDeliveryFailed } from '../src/jobs/deliverCertificate.js';
import { issueCertificates } from '../src/jobs/issueCertificates.js';
import { prisma, redis } from '../src/lib.js';
import { closeQueues } from '../src/queues.js';
import { SimulatedWhatsAppProvider } from '../src/whatsapp/provider.js';
import { approvedBatch, login, resetDb, sample, setupOtherDistrict } from './helpers.js';

const app = createApp();
beforeEach(resetDb);
afterAll(async () => {
  await prisma.$disconnect();
  await closeQueues();
  redis.disconnect();
});

const CERT_NO = /^CF-[0-9A-HJKMNP-TV-Z]{10}$/;
const PUBLIC_KEYS = ['status', 'certificateNo', 'candidateName', 'courseName', 'centreName', 'completionDate', 'issuedAt'];
const REASON = 'Issued in error to the wrong candidate';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Deterministic flaky provider: each send draws latency first, then the outcome. */
const flaky = (outcomes: number[]) => {
  const draws = outcomes.flatMap((o) => [0, o]);
  return new SimulatedWhatsAppProvider({ mode: 'flaky', latencyMs: [0, 0], slowMs: 300, random: () => draws.shift() ?? 0.9 });
};

const verify = (certNo: string) => request(app).get(`/api/public/verify/${certNo}`);
const revoke = (token: string, certNo: string, reason = REASON) =>
  request(app).post(`/api/certificates/${certNo}/revoke`).set('Authorization', `Bearer ${token}`).send({ reason });
const pdfBytes = (path: string, token?: string) => {
  const r = request(app).get(path);
  if (token) r.set('Authorization', `Bearer ${token}`);
  return r.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (d: Buffer) => chunks.push(d));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
};

/** An APPROVED batch, issued; returns its certificates with delivery and candidate. */
async function issued(csv?: string) {
  const id = await approvedBatch(app, csv);
  await issueCertificates(id);
  const certs = await prisma.certificate.findMany({ where: { batchId: id }, include: { delivery: true, candidate: true } });
  return { id, certs };
}

const delivery = (id: string) => prisma.delivery.findUniqueOrThrow({ where: { id } });
const batchStatus = async (id: string) => (await prisma.batch.findUniqueOrThrow({ where: { id } })).status;

describe('certificate issuance', { timeout: 30_000 }, () => {
  it('a 60-candidate batch gets exactly 60 certificates with unique numbers', async () => {
    const id = await approvedBatch(app, sample('valid-60.csv'));
    expect(await prisma.decision.count({ where: { batchId: id, stage: 'QUALITY', type: 'APPROVE' } })).toBe(1);
    expect((await issueCertificates(id))?.count).toBe(60);

    const certs = await prisma.certificate.findMany({ where: { batchId: id } });
    expect(certs).toHaveLength(60);
    expect(new Set(certs.map((c) => c.certificateNo)).size).toBe(60);
    expect(new Set(certs.map((c) => c.candidateId)).size).toBe(60);
    expect(certs.every((c) => CERT_NO.test(c.certificateNo))).toBe(true);
    expect(await prisma.delivery.count({ where: { certificate: { batchId: id }, status: 'PENDING' } })).toBe(60);
    expect(await batchStatus(id)).toBe('ISSUED');
  });

  it('re-running issuance (sequentially and 3x concurrently) never duplicates certificates or deliveries', async () => {
    const counts = async (id: string) => ({
      certs: await prisma.certificate.count({ where: { batchId: id } }),
      deliveries: await prisma.delivery.count({ where: { certificate: { batchId: id } } }),
      issuedAudits: await prisma.auditLog.count({ where: { entityType: 'Batch', entityId: id, action: 'CERTIFICATES_ISSUED' } }),
    });
    const expected = { certs: 10, deliveries: 10, issuedAudits: 1 };

    const a = await approvedBatch(app);
    expect((await issueCertificates(a))?.count).toBe(10);
    expect(await issueCertificates(a)).toBeNull();
    expect(await counts(a)).toEqual(expected);

    const b = await approvedBatch(app);
    const results = await Promise.all([1, 2, 3].map((n) => issueCertificates(b, { jobAttempt: n })));
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(await counts(b)).toEqual(expected);
    expect(await batchStatus(b)).toBe('ISSUED');
  });
});

describe('WhatsApp delivery', { timeout: 30_000 }, () => {
  it('delivery retries after failures and timeouts, and sends exactly one message', async () => {
    const { certs } = await issued();
    const d = certs[0].delivery!;
    const provider = flaky([0.1, 0.3, 0.9]); // 503 failure, accepted-but-slow (timeout), success

    await expect(deliverCertificate(d.id, provider, { timeoutMs: 100 })).rejects.toThrow(/503/);
    await expect(deliverCertificate(d.id, provider, { timeoutMs: 100 })).rejects.toThrow();
    await sleep(350); // let the slow send finish recording before the retry
    await expect(deliverCertificate(d.id, provider, { timeoutMs: 100 })).resolves.toBe('SENT');

    const after = await delivery(d.id);
    expect(after).toMatchObject({ status: 'SENT', attempts: 3 });
    expect(after.providerMessageId).toBeTruthy();
    expect(await prisma.outboundMessage.count({ where: { idempotencyKey: d.id } })).toBe(1);
    expect(await prisma.outboundMessage.count()).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityType: 'Delivery', entityId: d.id, action: 'CERTIFICATE_DELIVERED' } })).toBe(1);
  });

  it('a timeout after the provider accepted does not send twice', async () => {
    const { certs } = await issued();
    const d = certs[0].delivery!;
    const provider = flaky([0.3, 0.9]); // accepted-but-slow, then success

    await expect(deliverCertificate(d.id, provider, { timeoutMs: 100 })).rejects.toThrow();
    await sleep(350);
    expect(await prisma.outboundMessage.count({ where: { idempotencyKey: d.id } })).toBe(1);
    expect((await delivery(d.id)).status).toBe('PENDING');

    await expect(deliverCertificate(d.id, provider, { timeoutMs: 100 })).resolves.toBe('SENT');
    const after = await delivery(d.id);
    const msgs = await prisma.outboundMessage.findMany();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].providerMessageId).toBe(after.providerMessageId);
    expect(after).toMatchObject({ status: 'SENT', attempts: 2 });
  });

  it('a WhatsApp outage does not block issuance', async () => {
    const { id, certs } = await issued();
    const down = new SimulatedWhatsAppProvider({ mode: 'down', latencyMs: [0, 0] });
    for (const c of certs) await expect(deliverCertificate(c.delivery!.id, down, { timeoutMs: 100 })).rejects.toThrow(/503/);

    expect(await batchStatus(id)).toBe('ISSUED');
    for (const c of certs.slice(0, 2)) {
      const v = await verify(c.certificateNo);
      expect(v.status).toBe(200);
      expect(v.body.status).toBe('VALID');
    }
    expect(await prisma.delivery.count({ where: { certificate: { batchId: id }, status: 'SENT' } })).toBe(0);
    expect(await prisma.outboundMessage.count()).toBe(0);

    // Retries exhausted -> FAILED; the state office re-queues after the outage.
    const first = certs[0].delivery!.id;
    await markDeliveryFailed(first, '503 upstream unavailable');
    expect((await delivery(first)).status).toBe('FAILED');
    expect(await prisma.auditLog.count({ where: { entityType: 'Delivery', entityId: first, action: 'DELIVERY_FAILED' } })).toBe(1);

    const farah = await login(app, 'Farah');
    const r = await request(app).post('/api/deliveries/retry-failed').set(farah.auth);
    expect([200, 202]).toContain(r.status);
    expect(r.body.requeued).toBeGreaterThanOrEqual(1);
    expect((await delivery(first)).status).toBe('PENDING');
  });

  it('delivery is cancelled for a revoked certificate', async () => {
    const { certs } = await issued();
    const [c, other] = certs;
    const farah = await login(app, 'Farah');
    expect((await revoke(farah.token, c.certificateNo)).status).toBe(200);
    expect((await delivery(c.delivery!.id)).status).toBe('CANCELLED');

    const healthy = new SimulatedWhatsAppProvider({ mode: 'healthy', latencyMs: [0, 0] });
    expect(await deliverCertificate(c.delivery!.id, healthy)).toBe('CANCELLED');
    expect(await prisma.outboundMessage.count()).toBe(0);
    expect((await delivery(other.delivery!.id)).status).toBe('PENDING');
  });
});

describe('public verification', { timeout: 30_000 }, () => {
  it('public verification needs no auth and exposes only allowed fields', async () => {
    const { certs } = await issued();
    const c = certs[0];
    const res = await verify(c.certificateNo);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(Object.keys(res.body).sort()).toEqual([...PUBLIC_KEYS].sort());
    expect(res.body).toMatchObject({
      status: 'VALID',
      certificateNo: c.certificateNo,
      candidateName: c.candidate.fullName,
      courseName: 'Retail Sales Associate',
      centreName: 'Pragati Skill Centre, Kukatpally',
      completionDate: c.candidate.completionDate.toISOString().slice(0, 10),
    });
    const json = JSON.stringify(res.body);
    for (const secret of [c.candidate.phone, c.candidate.candidateRef, c.id, c.batchId]) expect(json).not.toContain(secret);
  });

  it('revoked certificates fail verification immediately', async () => {
    const { certs } = await issued();
    const [c, other] = certs;
    const farah = await login(app, 'Farah');
    expect((await revoke(farah.token, c.certificateNo)).status).toBe(200);

    const v = await verify(c.certificateNo);
    expect(v.status).toBe(200);
    expect(v.body.status).toBe('REVOKED');
    expect(v.body.revokedAt).toBeTruthy();
    expect(Object.keys(v.body).sort()).toEqual([...PUBLIC_KEYS, 'revokedAt'].sort());

    const p = await request(app).get(`/api/certificates/${c.certificateNo}/pdf?token=${encodeURIComponent(downloadToken(c.certificateNo))}`);
    expect(p.status).toBe(410);
    expect(p.body.error.code).toBe('CERTIFICATE_REVOKED');

    const again = await revoke(farah.token, c.certificateNo);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_REVOKED');
    expect((await revoke(farah.token, other.certificateNo, 'no')).status).toBe(400);
    for (const name of ['Anika', 'Dev']) expect((await revoke((await login(app, name)).token, other.certificateNo)).status).toBe(403);

    const row = await prisma.certificate.findUnique({ where: { id: c.id } });
    expect(row).toMatchObject({ status: 'REVOKED', revokedById: farah.user.id, revokeReason: REASON });
    const audits = await prisma.auditLog.findMany({ where: { entityType: 'Certificate', entityId: c.id, action: 'CERTIFICATE_REVOKED' } });
    expect(audits).toHaveLength(1);
    expect(audits[0].metadata).toMatchObject({ reason: REASON });
    expect((await prisma.certificate.findUniqueOrThrow({ where: { id: other.id } })).status).toBe('VALID');
  });

  it('unknown certificate gives INVALID 404, malformed gives 400', async () => {
    const u = await verify('CF-0000000000');
    expect(u.status).toBe(404);
    expect(u.body).toEqual({ status: 'INVALID' });
    expect(u.headers['cache-control']).toContain('no-store');
    for (const bad of ['abc', 'CF-123', 'CF-ILOUILOUIL']) {
      const r = await verify(bad);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('INVALID_FORMAT');
    }
  });

  it('public verify is rate limited', async () => {
    process.env.PUBLIC_RATE_LIMIT = '3';
    try {
      // 7 calls against a limit of 3: even if they straddle a window boundary, one window sees 4+.
      const res = [];
      for (let i = 0; i < 7; i++) res.push(await verify('CF-0000000000'));
      expect(res[0].status).toBe(404);
      const limited = res.find((r) => r.status === 429);
      expect(limited?.body.error.code).toBe('RATE_LIMITED');
    } finally {
      delete process.env.PUBLIC_RATE_LIMIT;
    }
  });
});

describe('PDF and staff reads', { timeout: 30_000 }, () => {
  it('PDF download: valid token works (body starts with %PDF), wrong token 403, another centre 403', async () => {
    const { certs } = await issued();
    const no = certs[0].certificateNo;
    const path = `/api/certificates/${no}/pdf`;

    const ok = await pdfBytes(`${path}?token=${encodeURIComponent(downloadToken(no))}`);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toContain('application/pdf');
    expect((ok.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');

    expect((await request(app).get(`${path}?token=${encodeURIComponent(downloadToken(certs[1].certificateNo))}`)).status).toBe(403);
    expect((await request(app).get(`${path}?token=garbage`)).status).toBe(403);
    expect((await request(app).get(path)).status).toBe(403);

    for (const name of ['Farah', 'Anika']) {
      const r = await pdfBytes(path, (await login(app, name)).token);
      expect(r.status).toBe(200);
      expect((r.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    }

    await setupOtherDistrict();
    expect((await request(app).get(path).set((await login(app, 'Ravi')).auth)).status).toBe(403);
    expect((await request(app).get('/api/certificates/CF-0000000000/pdf?token=x')).status).toBe(404);
  });

  it("staff can list a batch's certificates with delivery status; other district gets 404", async () => {
    const { id, certs } = await issued();
    const no = certs[0].certificateNo;
    const anika = await login(app, 'Anika');

    const list = await request(app).get(`/api/batches/${id}/certificates`).set(anika.auth);
    expect(list.status).toBe(200);
    expect(list.body.certificates).toHaveLength(10);
    expect(list.body.certificates[0]).toMatchObject({
      certificateNo: expect.stringMatching(CERT_NO),
      status: 'VALID',
      candidate: { fullName: expect.any(String), candidateRef: expect.any(String) },
      delivery: { status: 'PENDING', attempts: 0 },
    });

    const one = await request(app).get(`/api/certificates/${no}`).set(anika.auth);
    expect(one.status).toBe(200);
    expect(one.body.certificate).toMatchObject({ certificateNo: no, delivery: { status: 'PENDING' }, candidate: { fullName: certs[0].candidate.fullName } });
    expect(Array.isArray(one.body.certificate.audit)).toBe(true);

    await setupOtherDistrict();
    const omar = await login(app, 'Omar');
    expect((await request(app).get(`/api/batches/${id}/certificates`).set(omar.auth)).status).toBe(404);
    expect((await request(app).get(`/api/certificates/${no}`).set(omar.auth)).status).toBe(404);

    const farah = await login(app, 'Farah');
    const audit = await request(app).get(`/api/audit?entityType=Batch&entityId=${id}`).set(farah.auth);
    expect(audit.status).toBe(200);
    expect(audit.body.audit.map((a: { action: string }) => a.action)).toContain('CERTIFICATES_ISSUED');
    expect((await request(app).get('/api/audit').set(anika.auth)).status).toBe(403);
  });
});
