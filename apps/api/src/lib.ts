import { PrismaClient } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import { Redis } from 'ioredis';
import pino from 'pino';
import { config } from './config.js';

export const logger = pino({ level: config.logLevel });
export const prisma = new PrismaClient();
// maxRetriesPerRequest: null is required by BullMQ for shared connections.
export const createRedis = () => new Redis(config.redisUrl, { maxRetriesPerRequest: null });
export const redis = createRedis();

/** Express 4 does not catch rejected promises; forward them to the error handler. */
export const ah =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res, next).catch(next);
