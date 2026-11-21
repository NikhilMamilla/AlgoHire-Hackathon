import { Queue, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { createRedis, logger } from './lib.js';

export const QUEUES = { certificates: 'certificates', delivery: 'delivery', maintenance: 'maintenance' } as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const ISSUE_JOB_OPTS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 3600 },
  removeOnFail: { age: 86400 },
};
export const DELIVERY_JOB_OPTS: JobsOptions = { ...ISSUE_JOB_OPTS, attempts: 6 };

// One shared connection (from the single factory in lib.ts, maxRetriesPerRequest: null) for all producers.
// Created lazily so importing this module never opens a socket.
let connection: Redis | undefined;
const queues = new Map<QueueName, Queue>();

export function queue(name: QueueName): Queue {
  let q = queues.get(name);
  if (!q) {
    connection ??= createRedis();
    q = new Queue(name, { connection });
    queues.set(name, q);
  }
  return q;
}

export async function closeQueues() {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
  connection?.disconnect();
  connection = undefined;
}

/**
 * Enqueue without ever failing the caller: the DB change has already committed, and with Redis down
 * (maxRetriesPerRequest: null) an add would hang forever. The reconciler re-enqueues anything missed.
 */
async function safeEnqueue(what: string, fn: () => Promise<unknown>) {
  try {
    await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('enqueue timeout')), 2000))]);
  } catch (err) {
    logger.warn({ err, what }, 'enqueue failed; the reconciler will retry');
  }
}

export const enqueueIssue = (batchId: string, jobId = `issue-${batchId}`) =>
  safeEnqueue(`issue ${batchId}`, () => queue('certificates').add('issue-certificates', { batchId }, { ...ISSUE_JOB_OPTS, jobId }));

export const enqueueDeliveries = (deliveryIds: string[], prefix = 'deliver') =>
  deliveryIds.length
    ? safeEnqueue(`${deliveryIds.length} deliveries`, () =>
        queue('delivery').addBulk(
          deliveryIds.map((deliveryId) => ({ name: 'deliver', data: { deliveryId }, opts: { ...DELIVERY_JOB_OPTS, jobId: `${prefix}-${deliveryId}` } })),
        ),
      )
    : Promise.resolve();
