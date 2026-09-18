import { benchmarkJobSchema } from '@printer/contracts';
import { describe, expect, test } from 'vitest';
import { referenceId, referenceWorkloads } from '../src/index.js';
import type { ReferenceWorkload } from '../src/index.js';

describe('reference workload accounting', () => {
  test.each<ReferenceWorkload>(referenceWorkloads)(
    '$name has valid inputs and independently checked golden metrics',
    (workload) => {
      const { expected, jobs, printer } = workload;
      for (const { sequence, pagesCompleted, ...job } of jobs) {
        expect(benchmarkJobSchema.safeParse(job).success).toBe(true);
        expect(sequence).toBeGreaterThanOrEqual(0);
        expect(pagesCompleted).toBeLessThan(job.pages);
      }
      const outcomes = [
        ...expected.order,
        ...expected.blocked,
        ...expected.cancelled,
      ];
      expect(new Set(outcomes).size).toBe(jobs.length);
      expect([...outcomes].sort()).toEqual(jobs.map((job) => job.id).sort());
      expect(expected.intervals.map((interval) => interval.jobId)).toEqual(
        expected.order,
      );

      let wait = 0;
      let turnaround = 0;
      let busy = 0;
      let previousEnd = workload.dispatchStartsAtMs;
      for (const interval of expected.intervals) {
        const job = jobs.find((candidate) => candidate.id === interval.jobId);
        if (!job) throw new Error('Interval references a missing job.');
        expect(interval.startMs).toBeGreaterThanOrEqual(
          Math.max(previousEnd, job.arrivalTimeMs),
        );
        expect(job.colorMode === 'MONO' || printer.supportsColor).toBe(true);
        expect(!job.duplex || printer.supportsDuplex).toBe(true);
        const service = Math.ceil(
          ((job.pages - job.pagesCompleted) * 60_000) / printer.pagesPerMinute,
        );
        expect(interval.endMs - interval.startMs).toBe(service);
        wait += interval.startMs - job.arrivalTimeMs;
        turnaround += interval.endMs - job.arrivalTimeMs;
        busy += service;
        previousEnd = interval.endMs;
      }
      expect(expected.averageWaitMs).toBeCloseTo(wait / expected.order.length);
      expect(expected.averageTurnaroundMs).toBeCloseTo(
        turnaround / expected.order.length,
      );
      expect(expected.makespanMs).toBe(previousEnd);
      expect(expected.throughputJobsPerMinute).toBeCloseTo(
        (expected.order.length * 60_000) / previousEnd,
      );
      expect(expected.utilization).toBeCloseTo(busy / previousEnd);
    },
  );

  test('keeps the specified aging result and tie/cancellation cases explicit', () => {
    expect(
      referenceWorkloads[3].expected.effectivePrioritiesAtStart[referenceId(1)],
    ).toBe(35);
    expect(referenceWorkloads[4].cancellations[0].atMs).toBeLessThan(
      referenceWorkloads[4].expected.intervals[0].endMs,
    );
    expect(referenceWorkloads[6].jobs.map((job) => job.sequence)).toEqual([
      3, 1, 2,
    ]);
    expect(referenceWorkloads[6].expected.order).toEqual([
      referenceId(1),
      referenceId(2),
      referenceId(3),
    ]);
  });
});
