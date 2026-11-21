// Wires the plain job functions in src/jobs/* to BullMQ. No business logic lives here.
import { Worker, type Processor } from 'bullmq';
import './config.js';
import { issueCertificates } from './jobs/issueCertificates.js';
import { reconcile } from './jobs/reconcile.js';
import { createRedis, logger, prisma } from './lib.js';
import { closeQueues, queue, QUEUES, type QueueName } from './queues.js';

const workers: Worker[] = [];
function start(name: QueueName, processor: Processor, concurrency = 1) {
  const w = new Worker(name, processor, { connection: createRedis(), concurrency });
  w.on('ready', () => logger.info({ queue: name }, 'worker started'));
  w.on('failed', (job, err) => logger.warn({ queue: name, jobId: job?.id, attemptsMade: job?.attemptsMade, err: err.message }, 'job failed'));
  workers.push(w);
  return w;
}

start(QUEUES.certificates, (job) => issueCertificates(job.data.batchId, { jobAttempt: job.attemptsMade + 1 }));
start(QUEUES.maintenance, async () => logger.info(await reconcile(), 'reconcile'));
await queue('maintenance').upsertJobScheduler('reconcile-every-30s', { every: 30_000 }, { name: 'reconcile' });

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'worker shutting down');
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
