import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma, redis } from '../src/lib.js';
import { closeQueues } from '../src/queues.js';
import { auditActions, createBatch, csvOf, login, makeRows, resetDb, sample, uploadCsv } from './helpers.js';

const app = createApp();

beforeEach(resetDb);
afterAll(async () => {
  await prisma.$disconnect();
  await closeQueues();
  redis.disconnect();
});

const refs = async (batchId: string) =>
  (await prisma.candidate.findMany({ where: { batchId }, orderBy: { candidateRef: 'asc' } })).map((c) => c.candidateRef);

describe('csv upload', () => {
  it('invalid CSV reports row-level errors and saves nothing', async () => {
    const { token } = await login(app, 'Anika');
    const batch = await createBatch(app, token);
    const res = await uploadCsv(app, token, batch.id, sample('invalid.csv'));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CSV_INVALID');
    const errors = res.body.error.details.errors;
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ row: 9, field: 'full_name' }),
        expect.objectContaining({ row: 10, field: 'completion_date' }),
        expect.objectContaining({ row: 11, field: 'candidate_ref' }),
        expect.objectContaining({ row: 12, field: 'phone' }),
        expect.objectContaining({ row: 13, field: 'row', message: 'Row has 3 columns, expected 4' }),
      ]),
    );
    expect(errors).toHaveLength(5);
    expect(await prisma.candidate.count({ where: { batchId: batch.id } })).toBe(0);
    expect(await auditActions(batch.id)).toContain('CSV_REJECTED');
    expect(await auditActions(batch.id)).not.toContain('CSV_UPLOADED');
  });

  it('duplicate candidate_ref is reported with both row numbers', async () => {
    const { token } = await login(app, 'Anika');
    const batch = await createBatch(app, token);
    const rows = makeRows(3);
    rows.push(['T-0001', 'Someone Else', '9876543210', '2026-02-01']); // line 5 duplicates line 2
    const res = await uploadCsv(app, token, batch.id, csvOf(rows));
    expect(res.status).toBe(422);
    const dup = res.body.error.details.errors.find((e: { row: number }) => e.row === 5);
    expect(dup).toMatchObject({ row: 5, field: 'candidate_ref' });
    expect(dup.message).toMatch(/\b2\b/);
  });

  it('valid CSV re-upload replaces candidates atomically', async () => {
    const { token } = await login(app, 'Anika');
    const batch = await createBatch(app, token);

    const first = await uploadCsv(app, token, batch.id, sample('valid-10.csv'));
    expect(first.status).toBe(200);
    expect(first.body.count).toBe(10);
    expect(await prisma.candidate.count({ where: { batchId: batch.id } })).toBe(10);

    const second = await uploadCsv(app, token, batch.id, csvOf(makeRows(3)));
    expect(second.status).toBe(200);
    expect(second.body.count).toBe(3);
    expect(await refs(batch.id)).toEqual(['T-0001', 'T-0002', 'T-0003']);

    const bad = await uploadCsv(app, token, batch.id, sample('invalid.csv'));
    expect(bad.status).toBe(422);
    expect(await refs(batch.id)).toEqual(['T-0001', 'T-0002', 'T-0003']);
  });
});
