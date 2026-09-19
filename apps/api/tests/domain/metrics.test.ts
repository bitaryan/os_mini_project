import { describe, expect, test } from 'vitest';
import {
  calculateJobTiming,
  fairnessIndex,
  printerUtilization,
  summarize,
  throughputJobsPerMinute,
} from '../../src/domain/index.js';

describe('scheduler metrics', () => {
  test('calculates response, wait, service, and turnaround from simulation time', () => {
    expect(
      calculateJobTiming({
        arrivalMs: 100,
        firstStartMs: 300,
        completionMs: 1_000,
        serviceMs: 500,
      }),
    ).toEqual({
      responseMs: 200,
      waitMs: 400,
      serviceMs: 500,
      turnaroundMs: 900,
    });
  });

  test.each([
    { arrivalMs: -1, firstStartMs: 0, completionMs: 1, serviceMs: 1 },
    { arrivalMs: 1, firstStartMs: 0, completionMs: 2, serviceMs: 1 },
    { arrivalMs: 0, firstStartMs: 2, completionMs: 1, serviceMs: 1 },
    { arrivalMs: 0, firstStartMs: 0, completionMs: 1, serviceMs: 2 },
  ])('rejects invalid timing %j', (input) => {
    expect(() => calculateJobTiming(input)).toThrow(RangeError);
  });

  test('summarizes average, median, and nearest-rank p95', () => {
    expect(summarize([1, 2, 3, 4, 100])).toEqual({
      average: 22,
      median: 3,
      p95: 100,
    });
    expect(summarize([1, 3])).toEqual({ average: 2, median: 2, p95: 3 });
    expect(summarize([])).toEqual({ average: null, median: null, p95: null });
  });

  test('calculates throughput from elapsed simulation time', () => {
    expect(throughputJobsPerMinute(3, 12_000)).toBe(15);
    expect(throughputJobsPerMinute(0, 12_000)).toBe(0);
    expect(throughputJobsPerMinute(0, 0)).toBeNull();
  });

  test('uses Jain fairness over inverse normalized waits', () => {
    expect(fairnessIndex([1_000, 1_000, 1_000])).toBe(1);
    expect(fairnessIndex([0, 10_000])).toBeLessThan(0.51);
    expect(fairnessIndex([])).toBeNull();
  });

  test('calculates utilization only when online time exists', () => {
    expect(printerUtilization(6_000, 10_000)).toBe(0.6);
    expect(printerUtilization(0, 0)).toBeNull();
    expect(() => printerUtilization(2, 1)).toThrow(RangeError);
  });
});
