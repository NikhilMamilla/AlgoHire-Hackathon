import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Express } from 'express';
import request from 'supertest';
import { Role } from '@prisma/client';
import { prisma, redis } from '../src/lib.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const sample = (name: string) => path.resolve(here, '../../../samples', name);

export const HEADER = 'candidate_ref,full_name,phone,completion_date';

// The append-only trigger is a row-level BEFORE UPDATE/DELETE trigger. TRUNCATE does not fire
// row triggers, so test cleanup works while app-level UPDATE/DELETE on AuditLog stays blocked.
export async function resetDb() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "AuditLog","OutboundMessage","Delivery","Certificate","Decision","Candidate","Batch" RESTART IDENTITY CASCADE',
  );
  const keys = await redis.keys('rl:*');
  if (keys.length) await redis.del(...keys);
}

type Session = { token: string; user: { id: string; name: string; role: string }; auth: { Authorization: string } };
const sessions = new Map<string, Session>();

export async function login(app: Express, name: string): Promise<Session> {
  const cached = sessions.get(name);
  if (cached) return cached;
  const user = await prisma.user.findUniqueOrThrow({ where: { email: `${name.toLowerCase()}@demo.certiflow` } });
  const res = await request(app).post('/api/auth/demo-login').send({ userId: user.id });
  if (res.status !== 200) throw new Error(`login ${name} failed: ${res.status} ${JSON.stringify(res.body)}`);
  const s = { token: res.body.token, user: res.body.user, auth: { Authorization: `Bearer ${res.body.token}` } };
  sessions.set(name, s);
  return s;
}

export async function createBatch(app: Express, token: string, courseName = 'Retail Sales Associate') {
  const res = await request(app).post('/api/batches').set('Authorization', `Bearer ${token}`).send({ courseName });
  if (res.status !== 201) throw new Error(`createBatch failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.batch as { id: string; status: string; round: number; centreId: string; districtId: string };
}

export function uploadCsv(app: Express, token: string, batchId: string, file: string | Buffer, filename = 'upload.csv') {
  const buf = typeof file === 'string' ? fs.readFileSync(file) : file;
  return request(app)
    .post(`/api/batches/${batchId}/candidates/csv`)
    .set('Authorization', `Bearer ${token}`)
    .attach('file', buf, filename);
}

export const submit = (app: Express, token: string, batchId: string) =>
  request(app).post(`/api/batches/${batchId}/submit`).set('Authorization', `Bearer ${token}`);

export const decide = (app: Express, token: string, batchId: string, type: string, reason?: string) =>
  request(app)
    .post(`/api/batches/${batchId}/decisions`)
    .set('Authorization', `Bearer ${token}`)
    .send(reason === undefined ? { type } : { type, reason });

export const getBatch = (app: Express, token: string, batchId: string) =>
  request(app).get(`/api/batches/${batchId}`).set('Authorization', `Bearer ${token}`);

/** Anika creates a batch, uploads the CSV and submits it; returns the batch id (status DISTRICT_REVIEW). */
export async function readyBatch(app: Express, csvFile: string | Buffer = sample('valid-10.csv')) {
  const { token } = await login(app, 'Anika');
  const batch = await createBatch(app, token);
  const up = await uploadCsv(app, token, batch.id, csvFile);
  if (up.status !== 200) throw new Error(`upload failed: ${up.status} ${JSON.stringify(up.body)}`);
  const sub = await submit(app, token, batch.id);
  if (sub.status !== 200) throw new Error(`submit failed: ${sub.status} ${JSON.stringify(sub.body)}`);
  return batch.id;
}

/** readyBatch, then every review stage approves (Neha only when it lands in QUALITY_REVIEW). Returns an APPROVED batch id. */
export async function approvedBatch(app: Express, csvFile: string | Buffer = sample('valid-10.csv')) {
  const id = await readyBatch(app, csvFile);
  const approve = async (name: string) => {
    const res = await decide(app, (await login(app, name)).token, id, 'APPROVE');
    if (res.status !== 201) throw new Error(`${name} approve failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.batch.status as string;
  };
  await approve('Dev');
  if ((await approve('Meera')) === 'QUALITY_REVIEW') await approve('Neha');
  const final = await approve('Farah');
  if (final !== 'APPROVED') throw new Error(`expected APPROVED, got ${final}`);
  return id;
}

export const csvOf =(rows: string[][]) => Buffer.from([HEADER, ...rows.map((r) => r.join(','))].join('\n') + '\n');

export const makeRows = (n: number) =>
  Array.from({ length: n }, (_, i) => [
    `T-${String(i + 1).padStart(4, '0')}`,
    `Test Candidate ${i + 1}`,
    String(9000000000 + i),
    '2026-01-15',
  ]);

export const auditActions = async (batchId: string) =>
  (await prisma.auditLog.findMany({ where: { entityType: 'Batch', entityId: batchId }, orderBy: { id: 'asc' } })).map(
    (a) => a.action,
  );

/** Unavoidable direct setup: a second district/centre with its own officer and centre user. */
export async function setupOtherDistrict() {
  const warangal = await prisma.district.findUniqueOrThrow({ where: { name: 'Warangal' } });
  const centre = await prisma.centre.upsert({
    where: { id: 'centre-warangal-test' },
    update: {},
    create: { id: 'centre-warangal-test', name: 'Warangal Test Centre', districtId: warangal.id },
  });
  await prisma.user.upsert({
    where: { email: 'omar@demo.certiflow' },
    update: {},
    create: { name: 'Omar', email: 'omar@demo.certiflow', role: Role.DISTRICT_OFFICER, districtId: warangal.id },
  });
  await prisma.user.upsert({
    where: { email: 'ravi@demo.certiflow' },
    update: {},
    create: { name: 'Ravi', email: 'ravi@demo.certiflow', role: Role.CENTRE, districtId: warangal.id, centreId: centre.id },
  });
}
