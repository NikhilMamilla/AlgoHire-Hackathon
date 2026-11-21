import { Worker } from 'bullmq';
import './config.js';
import { createRedis, logger, prisma } from './lib.js';

export const CERTIFICATES_QUEUE = 'certificates';

const worker = new Worker(
  CERTIFICATES_QUEUE,
  async (job) => {
    logger.info({ jobId: job.id, name: job.name, data: job.data }, 'job received (no-op)');
  },
  { connection: createRedis() },
);

worker.on('ready', () => logger.info({ queue: CERTIFICATES_QUEUE }, 'worker started'));
worker.on('failed', (job, err) => logger.error({ jobId: job?.id, err }, 'job failed'));

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'worker shutting down');
  await worker.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
