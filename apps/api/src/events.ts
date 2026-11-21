import { enqueueIssue } from './queues.js';

/** Called after the approving transaction commits. Enqueue failures are logged; the reconciler covers them. */
export async function onBatchApproved(batchId: string) {
  await enqueueIssue(batchId);
}
