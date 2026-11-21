import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import pino from 'pino';
import { config } from './config.js';

export const logger = pino({ level: config.logLevel });
export const prisma = new PrismaClient();
// maxRetriesPerRequest: null is required by BullMQ for shared connections.
export const createRedis = () => new Redis(config.redisUrl, { maxRetriesPerRequest: null });
export const redis = createRedis();
