import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma, redis } from '../src/lib.js';
import { closeQueues } from '../src/queues.js';
import { createBatch, login, readyBatch, resetDb, uploadCsv } from './helpers.js';

const app = createApp();

beforeEach(resetDb);
afterAll(async () => {
  await prisma.$disconnect();
  await closeQueues();
  redis.disconnect();
});

describe('data minimisation', () => {
  it('only the owning centre sees full candidate phone numbers; staff get them masked', async () => {
    const id = await readyBatch(app);
    const fullPhones = (await prisma.candidate.findMany({ where: { batchId: id } })).map((c) => c.phone);

    const anika = await request(app).get(`/api/batches/${id}`).set((await login(app, 'Anika')).auth);
    expect(anika.body.batch.candidates.map((c: { phone: string }) => c.phone).sort()).toEqual([...fullPhones].sort());

    for (const name of ['Dev', 'Farah']) {
      const res = await request(app).get(`/api/batches/${id}`).set((await login(app, name)).auth);
      expect(res.status).toBe(200);
      for (const c of res.body.batch.candidates) expect(c.phone).toMatch(/^\*{6}\d{4}$/);
      const body = JSON.stringify(res.body);
      for (const p of fullPhones) expect(body).not.toContain(p);
    }
  });
});

describe('clean client errors (never a 500)', () => {
  it('malformed JSON is a 400 without a stack trace', async () => {
    const res = await request(app).post('/api/auth/demo-login').set('Content-Type', 'application/json').send('{"userId": ');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { code: 'BAD_REQUEST', message: 'Malformed request body' } });
    expect(JSON.stringify(res.body)).not.toMatch(/at .+\.(ts|js):\d+/);
  });

  it('CSV upload: oversize is 413, a non-CSV file is 422, a missing file is 400', async () => {
    const anika = await login(app, 'Anika');
    const { id } = await createBatch(app, anika.token);

    const big = await uploadCsv(app, anika.token, id, Buffer.alloc(1024 * 1024 + 1, 'a'), 'big.csv');
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('FILE_TOO_LARGE');

    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const notCsv = await uploadCsv(app, anika.token, id, png, 'photo.png');
    expect(notCsv.status).toBe(422);
    expect(notCsv.body.error.code).toBe('CSV_INVALID');

    const none = await request(app).post(`/api/batches/${id}/candidates/csv`).set(anika.auth);
    expect(none.status).toBe(400);

    expect(await prisma.candidate.count({ where: { batchId: id } })).toBe(0);
  });
});

describe('public stats', () => {
  it('returns aggregate certificate counts only, without auth', async () => {
    const res = await request(app).get('/api/public/stats');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ certificatesIssued: 0, validCertificates: 0 });
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
