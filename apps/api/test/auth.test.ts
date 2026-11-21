import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma, redis } from '../src/lib.js';
import { closeQueues } from '../src/queues.js';
import { createBatch, decide, getBatch, login, readyBatch, resetDb, setupOtherDistrict } from './helpers.js';

const app = createApp();
const secret = process.env.JWT_SECRET ?? 'dev-secret-change-me';
const me = (token: string) => request(app).get('/api/me').set('Authorization', `Bearer ${token}`);
const listIds = async (token: string) =>
  (await request(app).get('/api/batches').set('Authorization', `Bearer ${token}`)).body.batches.map((b: { id: string }) => b.id);

beforeEach(resetDb);
afterAll(async () => {
  await prisma.$disconnect();
  await closeQueues();
  redis.disconnect();
});

describe('authorization', () => {
  it('no token gives 401', async () => {
    const res = await request(app).get('/api/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect((await request(app).get('/api/batches')).status).toBe(401);
  });

  it('valid token returns the user from /api/me', async () => {
    const { token, user } = await login(app, 'Anika');
    const res = await me(token);
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(user.id);
  });

  it('tampered token gives 401', async () => {
    const { token } = await login(app, 'Anika');
    const [h, p, s] = token.split('.');
    // Flip a mid-signature char (the last char carries padding bits and may decode identically).
    const badSig = s.slice(0, 5) + (s[5] === 'A' ? 'B' : 'A') + s.slice(6);
    expect((await me(`${h}.${p}.${badSig}`)).status).toBe(401);

    const farah = await prisma.user.findUniqueOrThrow({ where: { email: 'farah@demo.certiflow' } });
    const payload = { ...JSON.parse(Buffer.from(p, 'base64url').toString()), sub: farah.id };
    const forgedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    expect((await me(`${h}.${forgedPayload}.${s}`)).status).toBe(401);

    const anika = await prisma.user.findUniqueOrThrow({ where: { email: 'anika@demo.certiflow' } });
    const wrongSecret = jwt.sign({ sub: anika.id }, 'not-the-secret', { algorithm: 'HS256', expiresIn: '1h' });
    expect((await me(wrongSecret)).status).toBe(401);
  });

  it('expired token gives 401', async () => {
    const anika = await prisma.user.findUniqueOrThrow({ where: { email: 'anika@demo.certiflow' } });
    const expired = jwt.sign({ sub: anika.id }, secret, { algorithm: 'HS256', expiresIn: -10 });
    expect((await me(expired)).status).toBe(401);
  });

  it('centre user approving gives 403', async () => {
    const id = await readyBatch(app);
    const { token } = await login(app, 'Anika');
    const res = await decide(app, token, id, 'APPROVE');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('quality acting at district stage gives 403', async () => {
    const id = await readyBatch(app);
    const { token } = await login(app, 'Neha');
    expect((await decide(app, token, id, 'APPROVE')).status).toBe(403);
  });

  it('officer from another district cannot see or act on the batch (404)', async () => {
    await setupOtherDistrict();
    const id = await readyBatch(app);
    const { token } = await login(app, 'Omar');
    expect((await getBatch(app, token, id)).status).toBe(404);
    expect((await decide(app, token, id, 'APPROVE')).status).toBe(404);
    expect(await listIds(token)).not.toContain(id);
    expect(await prisma.decision.count({ where: { batchId: id } })).toBe(0);
  });

  it("Anika cannot see another centre's batch", async () => {
    await setupOtherDistrict();
    const ravi = await login(app, 'Ravi');
    const batch = await createBatch(app, ravi.token);
    const { token } = await login(app, 'Anika');
    expect((await getBatch(app, token, batch.id)).status).toBe(404);
    expect(await listIds(token)).not.toContain(batch.id);
    expect((await getBatch(app, ravi.token, batch.id)).status).toBe(200);
  });

  it('demo-users exposes no emails', async () => {
    const res = await request(app).get('/api/auth/demo-users');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('@');
    for (const u of res.body.users) expect(u).not.toHaveProperty('email');
    expect(res.body.users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Anika', role: 'CENTRE', centreName: 'Pragati Skill Centre, Kukatpally' }),
        expect.objectContaining({ name: 'Dev', role: 'DISTRICT_OFFICER', districtName: 'Hyderabad' }),
      ]),
    );
  });

  it('demo-login with an unknown user gives 404', async () => {
    const res = await request(app).post('/api/auth/demo-login').send({ userId: 'does-not-exist' });
    expect(res.status).toBe(404);
  });
});
