import { describe, expect, test } from 'vitest';
import { REFERENCE_EPOCH, referenceWorkloads } from '@printer/test-fixtures';
import type { ReferenceWorkload } from '@printer/test-fixtures';
import type {
  DomainSchedulerConfig,
  PrintJob,
} from '../../src/domain/index.js';
import {
  SimulationClock,
  calculateJobTiming,
  printerUtilization,
  rankJobs,
  selectNextJob,
  summarize,
  throughputJobsPerMinute,
} from '../../src/domain/index.js';

describe('Week 1 reference workloads through the Week 2 scheduler', () => {
  test('keeps the reference epoch fixed', () => {
    expect(REFERENCE_EPOCH).toBe('2026-09-21T00:00:00.000Z');
  });

  test.each<ReferenceWorkload>(referenceWorkloads)(
    '$name reproduces the reviewed order, intervals, and metrics',
    (workload) => {
      const config: DomainSchedulerConfig = {
        algorithm: workload.algorithm,
        ...workload.aging,
      };
      const printer = {
        id: 'printer-1',
        status: 'READY' as const,
        ...workload.printer,
      };
      const remaining = workload.jobs.map<PrintJob>((fixture) => ({
        id: fixture.id,
        ownerId: 'reference-owner',
        documentName: fixture.id,
        pages: fixture.pages,
        pagesCompleted: fixture.pagesCompleted,
        basePriority: fixture.priority,
        colorMode: fixture.colorMode,
        duplex: fixture.duplex,
        status: 'READY',
        submittedAtMs: fixture.arrivalTimeMs,
        queuedAtMs: fixture.arrivalTimeMs,
        retryCount: 0,
        sequence: fixture.sequence,
        version: 0,
      }));
      const clock = new SimulationClock({
        simulationTimeMs: workload.dispatchStartsAtMs,
      });
      const cancelled = new Set<string>();
      const blocked = new Set<string>();
      const intervals: Array<{
        jobId: string;
        startMs: number;
        endMs: number;
      }> = [];
      const timings = [];

      const initialRanking = rankJobs(
        remaining,
        [printer],
        config,
        clock.state.simulationTimeMs,
      );
      if (workload.expected.effectivePrioritiesAtStart) {
        expect(
          Object.fromEntries(
            initialRanking.decisions.map((decision) => [
              decision.jobId,
              decision.effectivePriority,
            ]),
          ),
        ).toMatchObject(workload.expected.effectivePrioritiesAtStart);
      }

      while (remaining.length > 0) {
        for (const cancellation of workload.cancellations) {
          if (cancellation.atMs <= clock.state.simulationTimeMs)
            cancelled.add(cancellation.jobId);
        }
        for (let index = remaining.length - 1; index >= 0; index -= 1) {
          if (cancelled.has(remaining[index]?.id ?? ''))
            remaining.splice(index, 1);
        }

        const selection = selectNextJob(
          remaining,
          [printer],
          config,
          clock.state.simulationTimeMs,
        );
        selection.blockedJobIds.forEach((id) => blocked.add(id));
        if (!selection.selected) {
          const nextArrival = remaining
            .filter((job) => !blocked.has(job.id))
            .reduce<number | null>(
              (next, job) =>
                next === null || job.queuedAtMs < next ? job.queuedAtMs : next,
              null,
            );
          if (
            nextArrival === null ||
            nextArrival <= clock.state.simulationTimeMs
          )
            break;
          clock.advanceBy(nextArrival - clock.state.simulationTimeMs);
          continue;
        }

        const index = remaining.findIndex(
          (job) => job.id === selection.selected?.jobId,
        );
        const selected = remaining[index] as PrintJob;
        const startMs = clock.state.simulationTimeMs;
        const endMs = clock.advanceBy(selection.selected.predictedServiceMs);
        intervals.push({ jobId: selected.id, startMs, endMs });
        timings.push(
          calculateJobTiming({
            arrivalMs: selected.queuedAtMs,
            firstStartMs: startMs,
            completionMs: endMs,
            serviceMs: selection.selected.predictedServiceMs,
          }),
        );
        remaining.splice(index, 1);
      }

      const waits = summarize(timings.map((timing) => timing.waitMs));
      const turnarounds = summarize(
        timings.map((timing) => timing.turnaroundMs),
      );
      const busyMs = intervals.reduce(
        (total, interval) => total + interval.endMs - interval.startMs,
        0,
      );
      expect(intervals).toEqual(workload.expected.intervals);
      expect([...blocked]).toEqual(workload.expected.blocked);
      expect([...cancelled]).toEqual(workload.expected.cancelled);
      expect(waits.average).toBeCloseTo(workload.expected.averageWaitMs);
      expect(turnarounds.average).toBeCloseTo(
        workload.expected.averageTurnaroundMs,
      );
      expect(clock.state.simulationTimeMs).toBe(workload.expected.makespanMs);
      expect(
        throughputJobsPerMinute(intervals.length, clock.state.simulationTimeMs),
      ).toBeCloseTo(workload.expected.throughputJobsPerMinute);
      expect(
        printerUtilization(busyMs, clock.state.simulationTimeMs),
      ).toBeCloseTo(workload.expected.utilization);
    },
  );
});
