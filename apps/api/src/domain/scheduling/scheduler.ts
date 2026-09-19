import type { SchedulingAlgorithm } from '@printer/contracts';
import type {
  DomainSchedulerConfig,
  PrinterProfile,
  PrintJob,
} from '../entities.js';

export interface SchedulerExplanation {
  readonly algorithm: SchedulingAlgorithm;
  readonly rank: number;
  readonly criterion: 'arrival' | 'predicted_service' | 'effective_priority';
  readonly primaryValue: number;
  readonly tieBreakers: readonly ['queuedAtMs', 'sequence'];
  readonly summary: string;
}

export interface SchedulerDecision {
  readonly jobId: string;
  readonly effectivePriority: number;
  readonly predictedServiceMs: number;
  readonly explanation: SchedulerExplanation;
}

export interface SchedulerRanking {
  readonly decisions: readonly SchedulerDecision[];
  readonly blockedJobIds: readonly string[];
}

export interface SchedulerSelection {
  readonly selected: SchedulerDecision | null;
  readonly blockedJobIds: readonly string[];
}

interface Candidate {
  readonly job: PrintJob;
  readonly effectivePriority: number;
  readonly predictedServiceMs: number;
}

export function rankJobs(
  jobs: readonly PrintJob[],
  printers: readonly PrinterProfile[],
  config: DomainSchedulerConfig,
  nowMs: number,
): SchedulerRanking {
  validateInputs(config, nowMs);
  const { candidates, blocked } = candidatesFor(jobs, printers, config, nowMs);
  candidates.sort(comparator(config.algorithm));
  blocked.sort(byArrival);
  return {
    decisions: candidates.map((candidate, index) =>
      decisionFor(candidate, config.algorithm, index + 1),
    ),
    blockedJobIds: blocked.map((job) => job.id),
  };
}

export function selectNextJob(
  jobs: readonly PrintJob[],
  printers: readonly PrinterProfile[],
  config: DomainSchedulerConfig,
  nowMs: number,
): SchedulerSelection {
  validateInputs(config, nowMs);
  const onlinePrinters = printers.filter(isOnline);
  const compare = comparator(config.algorithm);
  const blocked: PrintJob[] = [];
  let selected: Candidate | null = null;

  for (const job of jobs) {
    if (job.status !== 'READY' || job.queuedAtMs > nowMs) continue;
    const candidate = candidateFor(job, onlinePrinters, config, nowMs);
    if (!candidate) {
      blocked.push(job);
      continue;
    }
    if (!selected || compare(candidate, selected) < 0) selected = candidate;
  }

  blocked.sort(byArrival);
  return {
    selected: selected ? decisionFor(selected, config.algorithm, 1) : null,
    blockedJobIds: blocked.map((job) => job.id),
  };
}

export function effectivePriority(
  job: Pick<PrintJob, 'basePriority' | 'queuedAtMs'>,
  nowMs: number,
  config: Pick<
    DomainSchedulerConfig,
    'agingIntervalMs' | 'agingFactor' | 'priorityCap'
  >,
): number {
  validateAging(config);
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new RangeError(
      'Simulation time must be a non-negative safe integer.',
    );
  }
  return effectivePriorityUnchecked(job, nowMs, config);
}

export function predictedServiceMs(
  job: Pick<
    PrintJob,
    'pages' | 'pagesCompleted' | 'colorMode' | 'duplex' | 'assignedPrinterId'
  >,
  printers: readonly PrinterProfile[],
): number | null {
  const compatible = printers.filter(
    (printer) => isOnline(printer) && supports(printer, job),
  );
  if (compatible.length === 0) return null;
  const assigned = job.assignedPrinterId
    ? compatible.find((printer) => printer.id === job.assignedPrinterId)
    : undefined;
  const pagesPerMinute =
    assigned?.pagesPerMinute ??
    median(compatible.map((printer) => printer.pagesPerMinute));
  if (!Number.isFinite(pagesPerMinute) || pagesPerMinute <= 0) {
    throw new RangeError('Printer speed must be a positive finite number.');
  }
  return Math.ceil(
    ((job.pages - job.pagesCompleted) * 60_000) / pagesPerMinute,
  );
}

function candidatesFor(
  jobs: readonly PrintJob[],
  printers: readonly PrinterProfile[],
  config: DomainSchedulerConfig,
  nowMs: number,
): { candidates: Candidate[]; blocked: PrintJob[] } {
  const onlinePrinters = printers.filter(isOnline);
  const candidates: Candidate[] = [];
  const blocked: PrintJob[] = [];
  for (const job of jobs) {
    if (job.status !== 'READY' || job.queuedAtMs > nowMs) continue;
    const candidate = candidateFor(job, onlinePrinters, config, nowMs);
    if (candidate) candidates.push(candidate);
    else blocked.push(job);
  }
  return { candidates, blocked };
}

function candidateFor(
  job: PrintJob,
  onlinePrinters: readonly PrinterProfile[],
  config: DomainSchedulerConfig,
  nowMs: number,
): Candidate | null {
  const serviceMs = predictedServiceMs(job, onlinePrinters);
  if (serviceMs === null) return null;
  return {
    job,
    predictedServiceMs: serviceMs,
    effectivePriority: effectivePriorityUnchecked(job, nowMs, config),
  };
}

function comparator(algorithm: SchedulingAlgorithm) {
  return (left: Candidate, right: Candidate): number => {
    if (algorithm === 'SJF') {
      const service = left.predictedServiceMs - right.predictedServiceMs;
      if (service !== 0) return service;
    } else if (algorithm === 'PRIORITY_AGING') {
      const priority = right.effectivePriority - left.effectivePriority;
      if (priority !== 0) return priority;
    }
    return byArrival(left.job, right.job);
  };
}

function byArrival(left: PrintJob, right: PrintJob): number {
  return (
    left.queuedAtMs - right.queuedAtMs ||
    left.sequence - right.sequence ||
    left.id.localeCompare(right.id)
  );
}

function decisionFor(
  candidate: Candidate,
  algorithm: SchedulingAlgorithm,
  rank: number,
): SchedulerDecision {
  const criterion =
    algorithm === 'FCFS'
      ? 'arrival'
      : algorithm === 'SJF'
        ? 'predicted_service'
        : 'effective_priority';
  const primaryValue =
    algorithm === 'FCFS'
      ? candidate.job.queuedAtMs
      : algorithm === 'SJF'
        ? candidate.predictedServiceMs
        : candidate.effectivePriority;
  const label =
    criterion === 'arrival'
      ? `queued at ${primaryValue} ms`
      : criterion === 'predicted_service'
        ? `predicted remaining service ${primaryValue} ms`
        : `effective priority ${primaryValue}`;
  return {
    jobId: candidate.job.id,
    effectivePriority: candidate.effectivePriority,
    predictedServiceMs: candidate.predictedServiceMs,
    explanation: {
      algorithm,
      rank,
      criterion,
      primaryValue,
      tieBreakers: ['queuedAtMs', 'sequence'],
      summary: `Rank ${rank}: ${label}; ties use earlier queue time, then sequence ${candidate.job.sequence}.`,
    },
  };
}

function effectivePriorityUnchecked(
  job: Pick<PrintJob, 'basePriority' | 'queuedAtMs'>,
  nowMs: number,
  config: Pick<
    DomainSchedulerConfig,
    'agingIntervalMs' | 'agingFactor' | 'priorityCap'
  >,
): number {
  const waitMs = Math.max(0, nowMs - job.queuedAtMs);
  return Math.min(
    config.priorityCap,
    job.basePriority +
      Math.floor(waitMs / config.agingIntervalMs) * config.agingFactor,
  );
}

function supports(
  printer: PrinterProfile,
  job: Pick<PrintJob, 'colorMode' | 'duplex'>,
): boolean {
  return (
    (job.colorMode === 'MONO' || printer.supportsColor) &&
    (!job.duplex || printer.supportsDuplex)
  );
}

function isOnline(printer: PrinterProfile): boolean {
  return printer.status !== 'OFFLINE' && printer.status !== 'ERROR';
}

function median(values: number[]): number {
  values.sort((left, right) => left - right);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 1
    ? (values[middle] as number)
    : ((values[middle - 1] as number) + (values[middle] as number)) / 2;
}

function validateInputs(config: DomainSchedulerConfig, nowMs: number): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new RangeError(
      'Simulation time must be a non-negative safe integer.',
    );
  }
  validateAging(config);
}

function validateAging(
  config: Pick<
    DomainSchedulerConfig,
    'agingIntervalMs' | 'agingFactor' | 'priorityCap'
  >,
): void {
  if (
    !Number.isSafeInteger(config.agingIntervalMs) ||
    config.agingIntervalMs < 1 ||
    !Number.isSafeInteger(config.agingFactor) ||
    config.agingFactor < 1 ||
    !Number.isSafeInteger(config.priorityCap) ||
    config.priorityCap < 1 ||
    config.priorityCap > 100
  ) {
    throw new RangeError('Invalid priority aging configuration.');
  }
}
