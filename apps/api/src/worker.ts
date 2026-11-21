// Wires the plain job functions in src/jobs/* to BullMQ. No business logic lives here.
import { writeFile } from 'node:fs/promises';
import { Worker, type Processor } from 'bullmq';
import './config.js';
import { deliverCertificate, markDeliveryFailed } from './jobs/deliverCertificate.js';
import { issueCertificates } from './jobs/issueCertificates.js';
import { escalateStuckBatches } from './jobs/escalate.js';
import { reconcile } from './jobs/reconcile.js';
import { createRedis, logger, prisma } from './lib.js';
import { closeQueues, queue, QUEUES, type QueueName } from './queues.js';
import { SimulatedWhatsAppProvider } from './whatsapp/provider.js';

const workers: Worker[] = [];
function start(name: QueueName, processor: Processor, concurrency = 1) {
  const w = new Worker(name, processor, { connection: createRedis(), concurrency });
  w.on('ready', () => logger.info({ queue: name }, 'worker started'));
  w.on('failed', (job, err) => logger.warn({ queue: name, jobId: job?.id, attemptsMade: job?.attemptsMade, err: err.message }, 'job failed'));
  workers.push(w);
  return w;
}

start(QUEUES.certificates, (job) => issueCertificates(job.data.batchId, { jobAttempt: job.attemptsMade + 1 }));
const provider = new SimulatedWhatsAppProvider();
start(QUEUES.delivery, (job) => deliverCertificate(job.data.deliveryId, provider), 5).on('failed', (job, err) => {
  // Out of retries: mark FAILED. The certificate itself stays VALID; POST /api/deliveries/retry-failed re-queues.
  if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
    markDeliveryFailed(job.data.deliveryId, err.message).catch((e) => logger.error({ err: e }, 'markDeliveryFailed'));
  }
});
start(QUEUES.maintenance, async (job) => {
  const result = job.name === 'escalate' ? await escalateStuckBatches() : await reconcile();
  logger.info(result, job.name);
});
await queue('maintenance').upsertJobScheduler('reconcile-every-30s', { every: 30_000 }, { name: 'reconcile' });
await queue('maintenance').upsertJobScheduler('escalate-every-30s', { every: 30_000 }, { name: 'escalate' });

// Liveness heartbeat for the compose healthcheck (the worker has no HTTP port).
const touch = () => writeFile('/tmp/worker-alive', String(Date.now())).catch(() => {});
void touch();
setInterval(touch, 10_000).unref();

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'worker shutting down');
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
