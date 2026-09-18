import type { BenchmarkJob, SchedulingAlgorithm } from '@printer/contracts';

export const REFERENCE_SEED = 42;
export const REFERENCE_EPOCH = '2026-09-21T00:00:00.000Z';
export const referenceId = (value: number) =>
  `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;

type ReferenceJob = BenchmarkJob & { sequence: number; pagesCompleted: number };
type Interval = { jobId: string; startMs: number; endMs: number };

export interface ReferenceWorkload {
  name: string;
  algorithm: SchedulingAlgorithm;
  dispatchStartsAtMs: number;
  printer: {
    pagesPerMinute: number;
    supportsColor: boolean;
    supportsDuplex: boolean;
  };
  aging: { agingIntervalMs: number; agingFactor: number; priorityCap: number };
  jobs: readonly ReferenceJob[];
  cancellations: readonly { jobId: string; atMs: number }[];
  expected: {
    order: readonly string[];
    blocked: readonly string[];
    cancelled: readonly string[];
    effectivePrioritiesAtStart?: Readonly<Record<string, number>>;
    intervals: readonly Interval[];
    averageWaitMs: number;
    averageTurnaroundMs: number;
    makespanMs: number;
    throughputJobsPerMinute: number;
    utilization: number;
  };
}

const job = (
  sequence: number,
  pages: number,
  arrivalTimeMs = 0,
  priority = 50,
): ReferenceJob => ({
  id: referenceId(sequence),
  sequence,
  pages,
  pagesCompleted: 0,
  arrivalTimeMs,
  priority,
  colorMode: 'MONO',
  duplex: false,
});
const interval = (
  sequence: number,
  startMs: number,
  endMs: number,
): Interval => ({ jobId: referenceId(sequence), startMs, endMs });
const common = {
  dispatchStartsAtMs: 0,
  printer: { pagesPerMinute: 60, supportsColor: false, supportsDuplex: true },
  aging: { agingIntervalMs: 5_000, agingFactor: 3, priorityCap: 100 },
  cancellations: [],
} as const;

export const referenceWorkloads = [
  {
    ...common,
    name: 'fcfs-arrivals',
    algorithm: 'FCFS',
    jobs: [job(1, 6), job(2, 2, 1_000), job(3, 4, 2_000)],
    expected: {
      order: [referenceId(1), referenceId(2), referenceId(3)],
      blocked: [],
      cancelled: [],
      intervals: [
        interval(1, 0, 6_000),
        interval(2, 6_000, 8_000),
        interval(3, 8_000, 12_000),
      ],
      averageWaitMs: 11_000 / 3,
      averageTurnaroundMs: 23_000 / 3,
      makespanMs: 12_000,
      throughputJobsPerMinute: 15,
      utilization: 1,
    },
  },
  {
    ...common,
    name: 'sjf-convoy',
    algorithm: 'SJF',
    jobs: [job(1, 6), job(2, 2), job(3, 4)],
    expected: {
      order: [referenceId(2), referenceId(3), referenceId(1)],
      blocked: [],
      cancelled: [],
      intervals: [
        interval(2, 0, 2_000),
        interval(3, 2_000, 6_000),
        interval(1, 6_000, 12_000),
      ],
      averageWaitMs: 8_000 / 3,
      averageTurnaroundMs: 20_000 / 3,
      makespanMs: 12_000,
      throughputJobsPerMinute: 15,
      utilization: 1,
    },
  },
  {
    ...common,
    name: 'priority-order',
    algorithm: 'PRIORITY_AGING',
    jobs: [job(1, 6, 0, 10), job(2, 2, 0, 80), job(3, 4, 0, 50)],
    expected: {
      order: [referenceId(2), referenceId(3), referenceId(1)],
      blocked: [],
      cancelled: [],
      intervals: [
        interval(2, 0, 2_000),
        interval(3, 2_000, 6_000),
        interval(1, 6_000, 12_000),
      ],
      averageWaitMs: 8_000 / 3,
      averageTurnaroundMs: 20_000 / 3,
      makespanMs: 12_000,
      throughputJobsPerMinute: 15,
      utilization: 1,
    },
  },
  {
    ...common,
    name: 'priority-aging-overtakes',
    algorithm: 'PRIORITY_AGING',
    dispatchStartsAtMs: 26_000,
    jobs: [job(1, 1, 0, 20), job(2, 1, 25_000, 34)],
    expected: {
      order: [referenceId(1), referenceId(2)],
      blocked: [],
      cancelled: [],
      effectivePrioritiesAtStart: {
        [referenceId(1)]: 35,
        [referenceId(2)]: 34,
      },
      intervals: [interval(1, 26_000, 27_000), interval(2, 27_000, 28_000)],
      averageWaitMs: 14_000,
      averageTurnaroundMs: 15_000,
      makespanMs: 28_000,
      throughputJobsPerMinute: 30 / 7,
      utilization: 1 / 14,
    },
  },
  {
    ...common,
    name: 'queued-cancellation',
    algorithm: 'FCFS',
    jobs: [job(1, 3), job(2, 2), job(3, 1)],
    cancellations: [{ jobId: referenceId(2), atMs: 1_000 }],
    expected: {
      order: [referenceId(1), referenceId(3)],
      blocked: [],
      cancelled: [referenceId(2)],
      intervals: [interval(1, 0, 3_000), interval(3, 3_000, 4_000)],
      averageWaitMs: 1_500,
      averageTurnaroundMs: 3_500,
      makespanMs: 4_000,
      throughputJobsPerMinute: 30,
      utilization: 1,
    },
  },
  {
    ...common,
    name: 'color-compatibility',
    algorithm: 'SJF',
    jobs: [{ ...job(1, 1), colorMode: 'COLOR' }, job(2, 2)],
    expected: {
      order: [referenceId(2)],
      blocked: [referenceId(1)],
      cancelled: [],
      intervals: [interval(2, 0, 2_000)],
      averageWaitMs: 0,
      averageTurnaroundMs: 2_000,
      makespanMs: 2_000,
      throughputJobsPerMinute: 30,
      utilization: 1,
    },
  },
  {
    ...common,
    name: 'simultaneous-arrivals',
    algorithm: 'FCFS',
    jobs: [job(3, 1), job(1, 1), job(2, 1)],
    expected: {
      order: [referenceId(1), referenceId(2), referenceId(3)],
      blocked: [],
      cancelled: [],
      intervals: [
        interval(1, 0, 1_000),
        interval(2, 1_000, 2_000),
        interval(3, 2_000, 3_000),
      ],
      averageWaitMs: 1_000,
      averageTurnaroundMs: 2_000,
      makespanMs: 3_000,
      throughputJobsPerMinute: 60,
      utilization: 1,
    },
  },
] as const satisfies readonly ReferenceWorkload[];
