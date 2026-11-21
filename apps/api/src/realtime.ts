import type { User } from '@prisma/client';
import type { Request, Response } from 'express';
import type { Redis } from 'ioredis';
import { userFromToken } from './auth.js';
import { HttpError } from './errors.js';
import { createRedis, logger, redis } from './lib.js';
import { canSeeEvent } from './scope.js';

/**
 * Domain events go through Redis pub/sub, not an in-process emitter: with several API instances (and the
 * separate worker process), an event produced on one instance or in the worker must reach SSE clients
 * connected to ANY instance. Each instance subscribes once and fans out to its own clients.
 */
export const EVENTS_CHANNEL = 'certiflow:events';

export type EventType =
  | 'batch.created'
  | 'batch.candidates'
  | 'batch.submitted'
  | 'batch.decision'
  | 'batch.status'
  | 'batch.escalated'
  | 'certificates.issued'
  | 'delivery.status'
  | 'certificate.revoked'
  | 'deliveries.requeued';

export type DomainEvent = {
  type: EventType;
  batchId?: string;
  certificateNo?: string;
  status?: string;
  districtId: string;
  centreId: string;
  at: string;
};

/** Call AFTER the DB commit. Never throws: a lost live update must not fail the request or job. */
export async function publish(e: Omit<DomainEvent, 'at'>) {
  try {
    await Promise.race([
      redis.publish(EVENTS_CHANNEL, JSON.stringify({ ...e, at: new Date().toISOString() })),
      new Promise((_, rej) => setTimeout(() => rej(new Error('publish timeout')), 1000)),
    ]);
  } catch (err) {
    logger.warn({ err, type: e.type }, 'event publish failed');
  }
}

/** Shorthand for events about one batch. */
export const publishBatch = (
  type: EventType,
  b: { id: string; status?: string; districtId: string; centreId: string },
  extra: Partial<DomainEvent> = {},
) => publish({ type, batchId: b.id, status: b.status, districtId: b.districtId, centreId: b.centreId, ...extra });

// --- SSE fan-out -----------------------------------------------------------------------------------------

type Client = { user: User; res: Response };
const clients = new Set<Client>();
let subscriber: Redis | undefined;
let subscribed: Promise<unknown> | undefined;

/** One subscription per API instance; resolves once Redis has confirmed SUBSCRIBE. */
function ensureSubscribed() {
  if (subscribed) return subscribed;
  subscriber = createRedis();
  subscribed = subscriber.subscribe(EVENTS_CHANNEL).catch((err) => {
    // Let the next client retry instead of every SSE request failing until restart.
    subscriber?.disconnect();
    subscriber = subscribed = undefined;
    throw err;
  });
  subscriber.on('message', (_channel, message: string) => {
    let e: DomainEvent;
    try {
      e = JSON.parse(message);
    } catch {
      return;
    }
    for (const c of clients) {
      canSeeEvent(c.user, e)
        .then((ok) => ok && c.res.write(`event: message\ndata: ${message}\n\n`))
        .catch((err) => logger.warn({ err }, 'SSE filter failed'));
    }
  });
  return subscribed;
}

export const HEARTBEAT_MS = 20_000;

/** GET /api/events?token=JWT (EventSource cannot send an Authorization header). */
export async function eventsHandler(req: Request, res: Response) {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (!token) throw new HttpError(401, 'UNAUTHENTICATED', 'Missing token');
  const user = await userFromToken(token);
  await ensureSubscribed();

  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write(`retry: 3000\n: connected as ${user.role}\n\n`);

  const client = { user, res };
  clients.add(client);
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), HEARTBEAT_MS);
  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(client);
  });
}

export async function closeRealtime() {
  for (const c of clients) c.res.end();
  clients.clear();
  subscriber?.disconnect();
  subscriber = undefined;
  subscribed = undefined;
}
