import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { escalateStuckBatches } from '../src/jobs/escalate.js';
import { prisma, redis } from '../src/lib.js';
import { closeQueues } from '../src/queues.js';
import { closeRealtime, publish } from '../src/realtime.js';
import { canSeeEvent } from '../src/scope.js';
import { auditActions, decide, login, readyBatch, resetDb, setupOtherDistrict } from './helpers.js';

const app = createApp();

beforeEach(resetDb);
afterAll(async () => {
  await closeRealtime();
  await prisma.$disconnect();
  await closeQueues();
  redis.disconnect();
});

describe('SLA escalation', () => {
  it('a stuck batch is escalated exactly once', async () => {
    const id = await readyBatch(app);
    // Unavoidable direct setup: backdate the stage entry past the SLA instead of waiting.
    const entered = new Date(Date.now() - (config.slaMinutes + 1) * 60_000);
    await prisma.batch.update({ where: { id }, data: { stageEnteredAt: entered } });

    const runs = [await escalateStuckBatches(), ...(await Promise.all([escalateStuckBatches(), escalateStuckBatches()]))];
    expect(runs.reduce((n, r) => n + r.escalated, 0)).toBe(1);
    expect((await auditActions(id)).filter((a) => a === 'BATCH_ESCALATED')).toHaveLength(1);
    const meta = (await prisma.auditLog.findFirst({ where: { entityId: id, action: 'BATCH_ESCALATED' } }))!.metadata as Record<string, unknown>;
    expect(meta).toMatchObject({ stage: 'DISTRICT' });
    expect(meta.minutesWaiting).toBeGreaterThanOrEqual(config.slaMinutes);

    const farah = await login(app, 'Farah');
    const listed = await request(app).get('/api/batches?escalated=true').set(farah.auth);
    expect(listed.status).toBe(200);
    expect(listed.body.batches.map((b: { id: string }) => b.id)).toEqual([id]);
    expect((await request(app).get('/api/batches?escalated=true').set((await login(app, 'Dev')).auth)).status).toBe(403);

    // Moving to the next stage clears escalation, so the next stage gets its own SLA clock.
    await decide(app, (await login(app, 'Dev')).token, id, 'APPROVE');
    await decide(app, (await login(app, 'Meera')).token, id, 'APPROVE');
    expect((await prisma.batch.findUniqueOrThrow({ where: { id } })).escalatedAt).toBeNull();
  });

  it('a batch inside its SLA is not escalated', async () => {
    const id = await readyBatch(app);
    expect((await escalateStuckBatches()).escalated).toBe(0);
    expect(await auditActions(id)).not.toContain('BATCH_ESCALATED');
  });
});

describe('live events', () => {
  it('events are filtered by the same visibility rules as batches', async () => {
    await setupOtherDistrict();
    const id = await readyBatch(app);
    const b = await prisma.batch.findUniqueOrThrow({ where: { id } });
    const e = { batchId: id, districtId: b.districtId, centreId: b.centreId };
    const user = (email: string) => prisma.user.findUniqueOrThrow({ where: { email: `${email}@demo.certiflow` } });

    expect(await canSeeEvent(await user('anika'), e)).toBe(true);
    expect(await canSeeEvent(await user('ravi'), e)).toBe(false);
    expect(await canSeeEvent(await user('dev'), e)).toBe(true);
    expect(await canSeeEvent(await user('omar'), e)).toBe(false);
    expect(await canSeeEvent(await user('farah'), e)).toBe(true);
    expect(await canSeeEvent(await user('neha'), e)).toBe(false); // DISTRICT_REVIEW is not quality's business
  });

  it('SSE requires a token and streams only visible events', async () => {
    expect((await request(app).get('/api/events')).status).toBe(401);
    expect((await request(app).get('/api/events?token=garbage')).status).toBe(401);

    await setupOtherDistrict();
    const anika = await login(app, 'Anika');
    const centreId = (await prisma.user.findUniqueOrThrow({ where: { id: anika.user.id } })).centreId!;
    const hyd = (await prisma.district.findUniqueOrThrow({ where: { name: 'Hyderabad' } })).id;
    const warangal = (await prisma.district.findUniqueOrThrow({ where: { name: 'Warangal' } })).id;

    const server = app.listen(0);
    const ctrl = new AbortController();
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/api/events?token=${anika.token}`, { signal: ctrl.signal });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const reader = res.body!.getReader();
      let text = '';
      const readUntil = async (needle: string) => {
        const deadline = Date.now() + 5000;
        while (!text.includes(needle)) {
          if (Date.now() > deadline) throw new Error(`timed out waiting for ${needle}; got: ${text}`);
          const { value, done } = await reader.read();
          if (done) break;
          text += new TextDecoder().decode(value);
        }
      };
      await readUntil('connected');
      await publish({ type: 'batch.status', batchId: 'other-centre', status: 'DRAFT', districtId: warangal, centreId: 'centre-warangal-test' });
      await publish({ type: 'batch.status', batchId: 'mine', status: 'DRAFT', districtId: hyd, centreId });
      await readUntil('"batchId":"mine"');
      expect(text).not.toContain('other-centre');
    } finally {
      ctrl.abort();
      server.close();
    }
  });
});

describe('state dashboards', () => {
  it('stats returns real counts and is STATE only', async () => {
    await readyBatch(app);
    const farah = await login(app, 'Farah');
    const res = await request(app).get('/api/stats').set(farah.auth);
    expect(res.status).toBe(200);
    expect(res.body.batches).toEqual({ DISTRICT_REVIEW: 1 });
    expect(res.body.certificates).toEqual({ total: 0, valid: 0, revoked: 0 });
    expect(res.body.deliveries).toEqual({ PENDING: 0, SENT: 0, FAILED: 0, CANCELLED: 0 });
    expect((await request(app).get('/api/stats').set((await login(app, 'Anika')).auth)).status).toBe(403);
  });

  it('outbox masks phone numbers and is STATE only', async () => {
    await prisma.outboundMessage.create({ data: { idempotencyKey: 'k1', to: '+919876543210', body: 'hello', providerMessageId: 'wamid.1' } });
    const res = await request(app).get('/api/dev/outbox').set((await login(app, 'Farah')).auth);
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([expect.objectContaining({ to: '******3210', body: 'hello' })]);
    expect(JSON.stringify(res.body)).not.toContain('9876543210');
    expect((await request(app).get('/api/dev/outbox').set((await login(app, 'Dev')).auth)).status).toBe(403);
  });
});
