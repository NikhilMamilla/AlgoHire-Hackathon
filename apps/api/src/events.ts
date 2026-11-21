import { logger } from './lib.js';

/** Called after the approving transaction commits. shortcut: logs only; Phase 3 enqueues certificate issuance on BullMQ. */
export async function onBatchApproved(batchId: string) {
  logger.info({ batchId }, 'batch approved (certificate issuance not wired yet)');
}
