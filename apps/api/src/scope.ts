import type { Prisma, User } from '@prisma/client';
import { HttpError } from './errors.js';

const NONE = '__none__';

/**
 * The single visibility rule for batches, used by every batch read and write.
 * Invisible batches answer 404 (not 403) so their existence is not leaked.
 */
export function batchScope(user: User): Prisma.BatchWhereInput {
  switch (user.role) {
    case 'CENTRE':
      return { centreId: user.centreId ?? NONE };
    case 'DISTRICT_OFFICER':
      return { districtId: user.districtId ?? NONE };
    case 'QUALITY':
      return { OR: [{ status: 'QUALITY_REVIEW' }, { decisions: { some: { actorId: user.id } } }] };
    case 'STATE':
      return {};
  }
}

export const batchNotFound = () => new HttpError(404, 'NOT_FOUND', 'Batch not found');

export async function assertVisible(db: Prisma.TransactionClient, user: User, batchId: string) {
  const n = await db.batch.count({ where: { AND: [{ id: batchId }, batchScope(user)] } });
  if (!n) throw batchNotFound();
}
