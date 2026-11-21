import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requireAuth, signToken } from '../auth.js';
import { HttpError } from '../errors.js';
import { ah, prisma } from '../lib.js';

export const authRouter = Router();

const publicUser = (u: { id: string; name: string; role: string; districtId: string | null; centreId: string | null }) => ({
  id: u.id,
  name: u.name,
  role: u.role,
  districtId: u.districtId,
  centreId: u.centreId,
});

authRouter.get(
  '/auth/demo-users',
  ah(async (_req, res) => {
    const users = await prisma.user.findMany({
      select: { id: true, name: true, role: true, district: { select: { name: true } }, centre: { select: { name: true } } },
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
    });
    res.json({
      users: users.map((u) => ({ id: u.id, name: u.name, role: u.role, districtName: u.district?.name ?? null, centreName: u.centre?.name ?? null })),
    });
  }),
);

authRouter.post(
  '/auth/demo-login',
  ah(async (req, res) => {
    const { userId } = z.object({ userId: z.string().min(1) }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new HttpError(404, 'NOT_FOUND', 'User not found');
    res.json({ token: signToken(user.id), user: publicUser(user) });
  }),
);

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(currentUser(req)) });
});
