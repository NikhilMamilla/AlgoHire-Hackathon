// DEMO AUTH: users log in by picking a seeded account; there are no passwords.
// Identity comes only from the signed Bearer JWT, and the user (and role) is re-loaded
// from the DB on every request, so all authorization is still enforced server-side.
import type { Role, User } from '@prisma/client';
import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { HttpError } from './errors.js';
import { prisma } from './lib.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

export const signToken = (userId: string) =>
  jwt.sign({}, config.jwtSecret, { algorithm: 'HS256', subject: userId, expiresIn: '8h' });

/** The Bearer user, or null when no Authorization header is sent. A bad or expired token is a 401. */
export async function userFromRequest(req: Express.Request & { headers: Record<string, unknown> }): Promise<User | null> {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header) return null;
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) throw new HttpError(401, 'UNAUTHENTICATED', 'Missing bearer token');
  let sub: string | undefined;
  try {
    sub = (jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as jwt.JwtPayload).sub;
  } catch {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Invalid or expired token');
  }
  const user = sub ? await prisma.user.findUnique({ where: { id: sub } }) : null;
  if (!user) throw new HttpError(401, 'UNAUTHENTICATED', 'User no longer exists');
  return user;
}

export const requireAuth: RequestHandler = async (req, _res, next) => {
  try {
    const user = await userFromRequest(req);
    if (!user) throw new HttpError(401, 'UNAUTHENTICATED', 'Missing bearer token');
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
};

export const requireRole =
  (...roles: Role[]): RequestHandler =>
  (req, _res, next) =>
    next(req.user && roles.includes(req.user.role) ? undefined : new HttpError(403, 'FORBIDDEN', 'Not allowed for your role'));

/** Narrow req.user after requireAuth. */
export const currentUser = (req: Express.Request): User => {
  if (!req.user) throw new HttpError(401, 'UNAUTHENTICATED', 'Not authenticated');
  return req.user;
};
