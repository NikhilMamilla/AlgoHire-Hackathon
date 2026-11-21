import type { RequestHandler } from 'express';
import { HttpError } from './errors.js';
import { logger, redis } from './lib.js';

/**
 * Redis fixed-window limiter: one counter per (prefix, client IP, window), INCR + EXPIRE in one MULTI.
 * Fails open (logs) if Redis is unavailable, so verification keeps working during a Redis outage.
 */
export const fixedWindowLimit =
  (prefix: string, limit: () => number, windowSec = 60): RequestHandler =>
  async (req, res, next) => {
    const nowSec = Math.floor(Date.now() / 1000);
    // Keyed on req.ip only (resolved by Express with `trust proxy` = 1 hop, i.e. nginx); never the raw X-Forwarded-For.
    const key = `rl:${prefix}:${req.ip}:${Math.floor(nowSec / windowSec)}`;
    let count: number;
    try {
      const result = await Promise.race([
        redis.multi().incr(key).expire(key, windowSec).exec(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('rate limit timeout')), 500)),
      ]);
      count = Number(result?.[0]?.[1] ?? 0);
    } catch (err) {
      // Deliberate fail-open: if Redis is down, keeping certificate verification available matters more than
      // strict limiting (numbers are 50-bit random, so a short unlimited window doesn't enable enumeration).
      logger.warn({ err, ip: req.ip }, 'rate limiter unavailable (Redis); failing open and allowing request');
      return next();
    }
    const max = limit();
    res.set('RateLimit-Limit', String(max));
    res.set('RateLimit-Remaining', String(Math.max(0, max - count)));
    if (count > max) {
      res.set('Retry-After', String(windowSec - (nowSec % windowSec)));
      return next(new HttpError(429, 'RATE_LIMITED', 'Too many requests, try again shortly'));
    }
    next();
  };
