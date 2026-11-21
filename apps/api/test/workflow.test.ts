import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma, redis } from '../src/lib.js';
import { closeQueues } from '../src/queues.js';
import {
  auditActions,
  csvOf,
  decide,
  getBatch,
  login,
  makeRows,
  readyBatch,
  resetDb,
  sample,
  submit,
  uploadCsv,
} from './helpers.js';

const app = createApp();

beforeEach(resetDb);
afterAll(async () => {
  await prisma.$disconnect();
  await closeQueues();
  redis.disconnect();
});

const status = async (id: string) => (await prisma.batch.findUniqueOrThrow({ where: { id } })).status;

describe('workflow', () => {
  it('audit log rejects UPDATE and DELETE but test reset can TRUNCATE', async () => {
    await prisma.auditLog.create({ data: { action: 'TEST', entityType: 'Test', entityId: '1', metadata: {} } });
    await expect(prisma.$executeRawUnsafe(`UPDATE "AuditLog" SET action = 'X'`)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "AuditLog"`)).rejects.toThrow(/append-only/);
    expect(await prisma.auditLog.count()).toBe(1);
    await resetDb();
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it('submitting a batch with no candidates is refused', async () => {
    const { token } = await login(app, 'Anika');
    const res = await request(app).post('/api/batches').set('Authorization', `Bearer ${token}`).send({ courseName: 'Empty' });
    const sub = await submit(app, token, res.body.batch.id);
    expect(sub.status).toBe(422);
    expect(sub.body.error.code).toBe('NO_CANDIDATES');
  });

  it('the same officer cannot approve twice', async () => {
    const id = await readyBatch(app);
    const dev = await login(app, 'Dev');
    expect((await decide(app, dev.token, id, 'APPROVE')).status).toBe(201);
    const again = await decide(app, dev.token, id, 'APPROVE');
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_DECIDED');
    expect(await status(id)).toBe('DISTRICT_REVIEW');
    expect(await prisma.decision.count({ where: { batchId: id } })).toBe(1);
  });

  it('two distinct officers advance a small batch to STATE_REVIEW', async () => {
    const id = await readyBatch(app);
    const [dev, meera] = [await login(app, 'Dev'), await login(app, 'Meera')];
    const first = await decide(app, dev.token, id, 'APPROVE');
    expect(first.body.batch.status).toBe('DISTRICT_REVIEW');
    const second = await decide(app, meera.token, id, 'APPROVE');
    expect(second.status).toBe(201);
    expect(second.body.batch.status).toBe('STATE_REVIEW');
    expect(await status(id)).toBe('STATE_REVIEW');
  });

  it('a batch of 60 goes to QUALITY_REVIEW', async () => {
    const id = await readyBatch(app, sample('valid-60.csv'));
    const [dev, meera] = [await login(app, 'Dev'), await login(app, 'Meera')];
    await decide(app, dev.token, id, 'APPROVE');
    await decide(app, meera.token, id, 'APPROVE');
    expect(await status(id)).toBe('QUALITY_REVIEW');
    const neha = await login(app, 'Neha');
    expect((await getBatch(app, neha.token, id)).status).toBe(200);
  });

  it('concurrent approvals advance the batch exactly once', async () => {
    const [dev, meera, kabir] = [await login(app, 'Dev'), await login(app, 'Meera'), await login(app, 'Kabir')];
    for (let i = 0; i < 5; i++) {
      const id = await readyBatch(app);
      const results = await Promise.all(
        [dev, meera, kabir, dev].map((s) => decide(app, s.token, id, 'APPROVE')),
      );
      const codes = results.map((r) => r.status);
      expect(codes.every((c) => c === 201 || c === 409)).toBe(true);
      expect(codes.filter((c) => c === 201)).toHaveLength(2);
      expect(await status(id)).toBe('STATE_REVIEW');
      expect((await auditActions(id)).filter((a) => a === 'BATCH_STAGE_ADVANCED')).toHaveLength(1);
      // Any 2 of the 3 officers can win the lock, so Dev may have 0 decisions (both 409) but never 2.
      expect(await prisma.decision.count({ where: { batchId: id, actorId: dev.user.id } })).toBeLessThanOrEqual(1);
      expect(await prisma.decision.count({ where: { batchId: id } })).toBe(2);
      // Dev's duplicate request can never both succeed.
      expect(results.filter((r, j) => (j === 0 || j === 3) && r.status === 201).length).toBeLessThanOrEqual(1);
    }
  }, 30_000);

  it('return and resubmit starts a new round; old approvals do not count', async () => {
    const id = await readyBatch(app);
    const [anika, dev, meera] = [await login(app, 'Anika'), await login(app, 'Dev'), await login(app, 'Meera')];

    expect((await decide(app, dev.token, id, 'APPROVE')).status).toBe(201);
    const ret = await decide(app, meera.token, id, 'RETURN', 'Phone numbers need correction');
    expect(ret.status).toBe(201);
    expect(ret.body.batch.status).toBe('RETURNED');

    expect((await uploadCsv(app, anika.token, id, csvOf(makeRows(5)))).status).toBe(200);
    const sub = await submit(app, anika.token, id);
    expect(sub.status).toBe(200);
    expect(sub.body.batch).toMatchObject({ status: 'DISTRICT_REVIEW', round: 2 });
    expect(await auditActions(id)).toContain('BATCH_RESUBMITTED');

    const devAgain = await decide(app, dev.token, id, 'APPROVE');
    expect(devAgain.status).toBe(201);
    expect(devAgain.body.batch.status).toBe('DISTRICT_REVIEW');
    const list = await request(app).get('/api/batches').set('Authorization', `Bearer ${dev.token}`);
    expect(list.body.batches.find((b: { id: string }) => b.id === id).approvals).toBe(1);

    const meeraApprove = await decide(app, meera.token, id, 'APPROVE');
    expect(meeraApprove.body.batch.status).toBe('STATE_REVIEW');
    expect(await prisma.decision.count({ where: { batchId: id, round: 1 } })).toBe(2);
    expect(await prisma.decision.count({ where: { batchId: id, round: 2 } })).toBe(2);
  });

  it('reject and return require a reason', async () => {
    const id = await readyBatch(app);
    const [dev, meera] = [await login(app, 'Dev'), await login(app, 'Meera')];

    const noReason = await decide(app, dev.token, id, 'REJECT');
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.code).toBe('VALIDATION_ERROR');
    expect((await decide(app, dev.token, id, 'RETURN', 'no')).status).toBe(400);
    expect(await prisma.decision.count({ where: { batchId: id } })).toBe(0);

    const rejected = await decide(app, dev.token, id, 'REJECT', 'Duplicate enrolment found');
    expect(rejected.status).toBe(201);
    expect(rejected.body.batch.status).toBe('REJECTED');
    expect(await auditActions(id)).toContain('BATCH_REJECTED');

    const after = await decide(app, meera.token, id, 'APPROVE');
    expect(after.status).toBe(409);
    expect(after.body.error.code).toBe('INVALID_STATE');
  });

  it('full path: DRAFT to APPROVED records an audit trail with every step', async () => {
    const id = await readyBatch(app);
    const [dev, meera, farah] = [await login(app, 'Dev'), await login(app, 'Meera'), await login(app, 'Farah')];
    await decide(app, dev.token, id, 'APPROVE');
    await decide(app, meera.token, id, 'APPROVE');
    const final = await decide(app, farah.token, id, 'APPROVE');
    expect(final.status).toBe(201);
    expect(final.body.batch.status).toBe('APPROVED');

    const res = await getBatch(app, farah.token, id);
    expect(res.status).toBe(200);
    expect(res.body.batch.status).toBe('APPROVED');
    expect(res.body.batch.audit.map((a: { action: string }) => a.action)).toEqual([
      'BATCH_CREATED',
      'CSV_UPLOADED',
      'BATCH_SUBMITTED',
      'DECISION_RECORDED',
      'DECISION_RECORDED',
      'BATCH_STAGE_ADVANCED',
      'DECISION_RECORDED',
      'BATCH_APPROVED',
    ]);
    expect(res.body.batch.decisions.map((d: { actor: { name: string } }) => d.actor.name)).toEqual(['Dev', 'Meera', 'Farah']);
    expect(res.body.batch.candidates).toHaveLength(10);
  });
});
