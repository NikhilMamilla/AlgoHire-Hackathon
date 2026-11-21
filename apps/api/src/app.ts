import { randomUUID } from 'node:crypto';
import express from 'express';
import { pinoHttp } from 'pino-http';
import { errorHandler, notFound } from './errors.js';
import { ah, logger, prisma, redis } from './lib.js';
import { eventsHandler } from './realtime.js';
import { auditRouter } from './routes/audit.js';
import { authRouter } from './routes/auth.js';
import { batchesRouter } from './routes/batches.js';
import { certificatesRouter } from './routes/certificates.js';
import { deliveriesRouter } from './routes/deliveries.js';
import { publicRouter } from './routes/public.js';
import { stateRouter } from './routes/state.js';

export function createApp() {
  const app = express();
  // Behind nginx (one hop): req.ip is the client address nginx appends to X-Forwarded-For.
  app.set('trust proxy', 1);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = (req.headers['x-request-id'] as string) ?? randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
    }),
  );
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/api/health/ready', async (_req, res) => {
    const check = async (fn: () => Promise<unknown>) => {
      try {
        // Without a timeout a down Redis (maxRetriesPerRequest: null) hangs the probe forever.
        await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000))]);
        return { status: 'ok' as const };
      } catch (e) {
        return { status: 'error' as const, error: (e as Error).message };
      }
    };
    const [postgres, redisCheck] = await Promise.all([
      check(() => prisma.$queryRaw`SELECT 1`),
      check(() => redis.ping()),
    ]);
    const ok = postgres.status === 'ok' && redisCheck.status === 'ok';
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', checks: { postgres, redis: redisCheck } });
  });

  app.use('/api', authRouter);
  app.use('/api', batchesRouter);
  app.use('/api', deliveriesRouter);
  app.use('/api', certificatesRouter);
  app.use('/api', publicRouter);
  app.use('/api', auditRouter);
  app.use('/api', stateRouter);
  app.get('/api/events', ah(eventsHandler));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
