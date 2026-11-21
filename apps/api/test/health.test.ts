import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma, redis } from '../src/lib.js';
import { closeQueues } from '../src/queues.js';

afterAll(async () => {
  await prisma.$disconnect();
  await closeQueues();
  redis.disconnect();
});

describe('health', () => {
  it('GET /api/health returns 200', async () => {
    const res = await request(createApp()).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /api/health/ready reports postgres and redis', async () => {
    const res = await request(createApp()).get('/api/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.checks.postgres.status).toBe('ok');
    expect(res.body.checks.redis.status).toBe('ok');
  });
});
