import { describe, expect, test } from 'vitest';
import type { BenchmarkJob, BenchmarkRequest } from '@printer/contracts';
import { benchmarkResultSchema } from '@printer/contracts';
import { runBenchmark } from '../src/application/index.js';

describe('Week 6 benchmark engine', () => {
  test('is byte-deterministic and completes the 10,000-job limit', () => {
    const jobs: BenchmarkJob[] = Array.from({ length: 10_000 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
      arrivalTimeMs: index % 1_000,
      pages: (index % 100) + 1,
      priority: index % 101,
      colorMode: 'MONO',
      duplex: false,
    }));
    const request = {
      source: { kind: 'EXPLICIT', jobs },
      algorithms: ['FCFS', 'SJF', 'PRIORITY_AGING'],
      printerModel: {
        count: 64,
        pagesPerMinute: 60,
        supportsColor: true,
        supportsDuplex: true,
      },
      seed: 42,
    } satisfies BenchmarkRequest;
    const started = performance.now();
    const first = runBenchmark(
      request,
      jobs,
      '10000000-0000-4000-8000-000000000001',
    );
    const second = runBenchmark(
      request,
      jobs,
      '10000000-0000-4000-8000-000000000001',
    );

    benchmarkResultSchema.parse(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.evaluations.every((run) => run.jobs.length === 10_000)).toBe(
      true,
    );
    expect(
      first.evaluations.every((run) =>
        run.jobs.every((job) => job.waitMs >= 0),
      ),
    ).toBe(true);
    expect(performance.now() - started).toBeLessThan(10_000);
  });
});
