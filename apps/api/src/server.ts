import { config } from './config.js';
import { createApp } from './app.js';
import { logger, prisma, redis } from './lib.js';

const server = createApp().listen(config.port, () => logger.info({ port: config.port }, 'api listening'));

const shutdown = (signal: string) => {
  logger.info({ signal }, 'api shutting down');
  server.close(async () => {
    await Promise.allSettled([prisma.$disconnect(), redis.quit()]);
    process.exit(0);
  });
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
