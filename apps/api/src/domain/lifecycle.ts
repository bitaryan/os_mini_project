import type { JobStatus } from '@printer/contracts';
import type { PrintJob } from './entities.js';
import { isTerminalStatus } from './entities.js';

const transitions = {
  QUEUED: ['READY', 'CANCELLED'],
  READY: ['PRINTING', 'BLOCKED', 'CANCELLED', 'FAILED'],
  PRINTING: ['PAUSED', 'COMPLETED', 'CANCELLED', 'FAILED'],
  PAUSED: ['PRINTING', 'READY', 'CANCELLED', 'FAILED'],
  BLOCKED: ['READY', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
  FAILED: [],
} as const satisfies Record<JobStatus, readonly JobStatus[]>;

type TransitionPatch = Partial<
  Pick<
    PrintJob,
    | 'pagesCompleted'
    | 'startedAtMs'
    | 'completedAtMs'
    | 'cancellationRequestedAtMs'
    | 'lastProgressAtMs'
    | 'retryCount'
  >
> & { readonly assignedPrinterId?: string | null };

export class InvalidJobTransitionError extends Error {
  readonly code = 'INVALID_TRANSITION';

  constructor(from: JobStatus, to: JobStatus) {
    super(`Cannot transition a job from ${from} to ${to}.`);
    this.name = 'InvalidJobTransitionError';
  }
}

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return (transitions[from] as readonly JobStatus[]).includes(to);
}

export function assertJobInvariants(job: PrintJob): void {
  const integerFields = [
    job.pages,
    job.pagesCompleted,
    job.submittedAtMs,
    job.queuedAtMs,
    job.retryCount,
    job.sequence,
    job.version,
    job.startedAtMs,
    job.completedAtMs,
    job.cancellationRequestedAtMs,
    job.lastProgressAtMs,
  ];
  if (
    integerFields.some(
      (value) =>
        value !== undefined && (!Number.isSafeInteger(value) || value < 0),
    )
  ) {
    throw new Error(
      'Job counters and simulation times must be non-negative safe integers.',
    );
  }
  if (job.pages < 1 || job.pagesCompleted > job.pages) {
    throw new Error('Completed pages must stay within the job page count.');
  }
  if (job.pages > 10_000) throw new Error('A job cannot exceed 10,000 pages.');
  if (
    !Number.isSafeInteger(job.basePriority) ||
    job.basePriority < 0 ||
    job.basePriority > 100
  ) {
    throw new Error('Base priority must be an integer from 0 to 100.');
  }
  if (!job.id || !job.ownerId || !job.documentName.trim()) {
    throw new Error('Job identity and document name are required.');
  }
  if (job.queuedAtMs < job.submittedAtMs) {
    throw new Error('A job cannot enter the queue before submission.');
  }
  if (job.startedAtMs !== undefined && job.startedAtMs < job.queuedAtMs) {
    throw new Error('A job cannot start before it is queued.');
  }
  if (
    job.completedAtMs !== undefined &&
    (job.startedAtMs === undefined || job.completedAtMs < job.startedAtMs)
  ) {
    throw new Error('A job cannot complete before it starts.');
  }
  if (
    (job.status === 'PRINTING' || job.status === 'PAUSED') &&
    !job.assignedPrinterId
  ) {
    throw new Error('Printing and paused jobs require an assigned printer.');
  }
  if (isTerminalStatus(job.status) && job.assignedPrinterId !== undefined) {
    throw new Error('Terminal jobs cannot retain a printer assignment.');
  }
  if (!isTerminalStatus(job.status) && job.pagesCompleted === job.pages) {
    throw new Error('A nonterminal job must have pages remaining.');
  }
  if (
    job.status === 'COMPLETED' &&
    (job.pagesCompleted !== job.pages || job.completedAtMs === undefined)
  ) {
    throw new Error('Completed jobs require all pages and a completion time.');
  }
}

export function transitionJob(
  job: PrintJob,
  status: JobStatus,
  patch: TransitionPatch = {},
): PrintJob {
  if (!canTransition(job.status, status)) {
    throw new InvalidJobTransitionError(job.status, status);
  }

  const { assignedPrinterId, ...changes } = patch;
  const nextPrinterId = assignedPrinterId ?? job.assignedPrinterId;
  const next: PrintJob = {
    ...job,
    ...changes,
    ...(assignedPrinterId === null || nextPrinterId === undefined
      ? {}
      : { assignedPrinterId: nextPrinterId }),
    status,
    version: job.version + 1,
  };
  if (assignedPrinterId === null) {
    delete (next as { assignedPrinterId?: string }).assignedPrinterId;
  }
  assertJobInvariants(next);
  return next;
}
