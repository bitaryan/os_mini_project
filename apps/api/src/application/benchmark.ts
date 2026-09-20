import { createHash, randomUUID } from 'node:crypto';
import type {
  BenchmarkJob,
  BenchmarkRequest,
  BenchmarkResult,
  SchedulingAlgorithm,
} from '@printer/contracts';
import { fairnessIndex, summarize } from '../domain/index.js';

type Aging = NonNullable<BenchmarkRequest['aging']>;
type Evaluation = BenchmarkResult['evaluations'][number];

const defaultAging: Aging = {
  agingIntervalMs: 5_000,
  agingFactor: 2,
  priorityCap: 100,
};

export function workloadHash(jobs: readonly BenchmarkJob[]): string {
  const normalized = [...jobs].sort(
    (left, right) =>
      left.arrivalTimeMs - right.arrivalTimeMs ||
      left.id.localeCompare(right.id),
  );
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export function runBenchmark(
  request: BenchmarkRequest,
  jobs: readonly BenchmarkJob[],
  benchmarkId: string = randomUUID(),
  timeoutMs = 10_000,
): BenchmarkResult {
  if (jobs.length === 0 || jobs.length > 10_000)
    throw new RangeError('A benchmark requires between 1 and 10,000 jobs.');
  if (
    jobs.some(
      (job) =>
        (job.colorMode === 'COLOR' && !request.printerModel.supportsColor) ||
        (job.duplex && !request.printerModel.supportsDuplex),
    )
  ) {
    throw new RangeError('Every benchmark job must match the printer model.');
  }
  const hash = workloadHash(jobs);
  const aging = request.aging ?? defaultAging;
  const deadline = performance.now() + timeoutMs;
  return {
    benchmarkId,
    status: 'COMPLETED',
    engineVersion: 1,
    workloadHash: hash,
    seed: request.seed,
    jobCount: jobs.length,
    normalizedConfig: { algorithms: request.algorithms, aging },
    printerModel: request.printerModel,
    evaluations: request.algorithms.map((algorithm) =>
      evaluate(algorithm, request, jobs, deadline),
    ),
  };
}

function evaluate(
  algorithm: SchedulingAlgorithm,
  request: BenchmarkRequest,
  jobs: readonly BenchmarkJob[],
  deadline: number,
): Evaluation {
  const aging = request.aging ?? defaultAging;
  const arrivals = [...jobs].sort(
    (left, right) =>
      left.arrivalTimeMs - right.arrivalTimeMs ||
      left.id.localeCompare(right.id),
  );
  const printers = Array.from(
    { length: request.printerModel.count },
    (_, index) => ({ id: index + 1, availableAt: 0 }),
  );
  const completed: Evaluation['jobs'][number][] = [];
  const ready: BenchmarkJob[] = [];
  let arrivalIndex = 0;
  let simulationTimeMs = 0;
  let serviceMs = 0;

  while (completed.length < arrivals.length) {
    if ((completed.length & 255) === 0 && performance.now() > deadline)
      throw new RangeError('Benchmark exceeded the 10 second execution limit.');
    printers.sort(
      (left, right) =>
        left.availableAt - right.availableAt || left.id - right.id,
    );
    const printer = printers[0] as (typeof printers)[number];
    const now = Math.max(
      printer.availableAt,
      simulationTimeMs,
      ready.length === 0
        ? (arrivals[arrivalIndex]?.arrivalTimeMs ?? printer.availableAt)
        : printer.availableAt,
    );
    simulationTimeMs = now;
    while (
      arrivalIndex < arrivals.length &&
      (arrivals[arrivalIndex] as BenchmarkJob).arrivalTimeMs <= now
    ) {
      ready.push(arrivals[arrivalIndex] as BenchmarkJob);
      arrivalIndex += 1;
    }
    let selectedIndex = 0;
    for (let index = 1; index < ready.length; index += 1) {
      if (
        compare(
          ready[index] as BenchmarkJob,
          ready[selectedIndex] as BenchmarkJob,
          algorithm,
          now,
          aging,
        ) < 0
      )
        selectedIndex = index;
    }
    const [job] = ready.splice(selectedIndex, 1) as [BenchmarkJob];
    const duration = Math.ceil(
      (job.pages * 60_000) / request.printerModel.pagesPerMinute,
    );
    const endMs = now + duration;
    printer.availableAt = endMs;
    serviceMs += duration;
    completed.push({
      jobId: job.id,
      printer: printer.id,
      startMs: now,
      endMs,
      waitMs: now - job.arrivalTimeMs,
      turnaroundMs: endMs - job.arrivalTimeMs,
    });
  }

  completed.sort(
    (left, right) =>
      left.startMs - right.startMs || left.jobId.localeCompare(right.jobId),
  );
  const waits = completed.map((job) => job.waitMs);
  const turnarounds = completed.map((job) => job.turnaroundMs);
  const waitSummary = summarize(waits);
  const makespanMs = Math.max(...completed.map((job) => job.endMs));
  return {
    metrics: {
      algorithm,
      averageWaitMs: waitSummary.average ?? 0,
      medianWaitMs: waitSummary.median ?? 0,
      p95WaitMs: waitSummary.p95 ?? 0,
      maximumWaitMs: Math.max(...waits),
      averageTurnaroundMs: average(turnarounds),
      makespanMs,
      throughputJobsPerMinute: (completed.length * 60_000) / makespanMs,
      printerUtilization: serviceMs / (request.printerModel.count * makespanMs),
      fairnessIndex: fairnessIndex(waits) ?? 1,
      starvationCount: waits.filter((wait) => wait >= 30_000).length,
    },
    jobs: completed,
  };
}

function compare(
  left: BenchmarkJob,
  right: BenchmarkJob,
  algorithm: SchedulingAlgorithm,
  nowMs: number,
  aging: Aging,
): number {
  if (algorithm === 'SJF' && left.pages !== right.pages)
    return left.pages - right.pages;
  if (algorithm === 'PRIORITY_AGING') {
    const priority =
      effectivePriority(right, nowMs, aging) -
      effectivePriority(left, nowMs, aging);
    if (priority !== 0) return priority;
  }
  return (
    left.arrivalTimeMs - right.arrivalTimeMs || left.id.localeCompare(right.id)
  );
}

function effectivePriority(job: BenchmarkJob, nowMs: number, aging: Aging) {
  return Math.min(
    aging.priorityCap,
    job.priority +
      Math.floor((nowMs - job.arrivalTimeMs) / aging.agingIntervalMs) *
        aging.agingFactor,
  );
}

function average(values: readonly number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
