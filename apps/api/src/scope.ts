import type { Prisma, User } from '@prisma/client';
import { HttpError } from './errors.js';
import { prisma } from './lib.js';

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

/**
 * Live-event visibility: the same rules as batchScope. CENTRE / DISTRICT_OFFICER / STATE depend only on the
 * event's centre/district, so they are checked in memory; QUALITY depends on status and past decisions, so it
 * asks the DB through batchScope itself.
 */
export async function canSeeEvent(user: User, e: { batchId?: string; centreId: string; districtId: string }) {
  switch (user.role) {
    case 'STATE':
      return true;
    case 'CENTRE':
      return !!user.centreId && e.centreId === user.centreId;
    case 'DISTRICT_OFFICER':
      return !!user.districtId && e.districtId === user.districtId;
    case 'QUALITY':
      return !!e.batchId && (await prisma.batch.count({ where: { AND: [{ id: e.batchId }, batchScope(user)] } })) > 0;
  }
}

export const batchNotFound = () => new HttpError(404, 'NOT_FOUND', 'Batch not found');

export async function assertVisible(db: Prisma.TransactionClient, user: User, batchId: string) {
  const n = await db.batch.count({ where: { AND: [{ id: batchId }, batchScope(user)] } });
  if (!n) throw batchNotFound();
}
