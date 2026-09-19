import { performance } from 'node:perf_hooks';
import { describe, expect, test } from 'vitest';
import type {
  DomainSchedulerConfig,
  PrinterProfile,
  PrintJob,
} from '../../src/domain/index.js';
import {
  effectivePriority,
  rankJobs,
  selectNextJob,
} from '../../src/domain/index.js';

const config = (
  algorithm: DomainSchedulerConfig['algorithm'],
  overrides: Partial<DomainSchedulerConfig> = {},
): DomainSchedulerConfig => ({
  algorithm,
  agingIntervalMs: 5_000,
  agingFactor: 2,
  priorityCap: 100,
  ...overrides,
});
const printer = (overrides: Partial<PrinterProfile> = {}): PrinterProfile => ({
  id: 'printer-1',
  status: 'READY',
  pagesPerMinute: 60,
  supportsColor: true,
  supportsDuplex: true,
  ...overrides,
});
const job = (id: string, overrides: Partial<PrintJob> = {}): PrintJob => ({
  id,
  ownerId: 'owner-1',
  documentName: id,
  pages: 1,
  pagesCompleted: 0,
  basePriority: 50,
  colorMode: 'MONO',
  duplex: false,
  status: 'READY',
  submittedAtMs: 0,
  queuedAtMs: 0,
  retryCount: 0,
  sequence: Number(id.replace(/\D/g, '')) || 1,
  version: 0,
  ...overrides,
});
const order = (
  jobs: readonly PrintJob[],
  algorithm: DomainSchedulerConfig['algorithm'],
  printers: readonly PrinterProfile[] = [printer()],
  nowMs = 0,
) =>
  rankJobs(jobs, printers, config(algorithm), nowMs).decisions.map(
    (decision) => decision.jobId,
  );

describe('FCFS', () => {
  test('SCH-001 orders by arrival', () => {
    expect(
      order(
        [
          job('A', { queuedAtMs: 0 }),
          job('B', { queuedAtMs: 10 }),
          job('C', { queuedAtMs: 20 }),
        ],
        'FCFS',
        [printer()],
        20,
      ),
    ).toEqual(['A', 'B', 'C']);
  });
  test('SCH-002 breaks simultaneous arrivals by sequence', () => {
    expect(
      order(
        [
          job('A', { sequence: 3 }),
          job('B', { sequence: 1 }),
          job('C', { sequence: 2 }),
        ],
        'FCFS',
      ),
    ).toEqual(['B', 'C', 'A']);
  });
  test('SCH-003 ignores priority', () => {
    expect(
      order(
        [
          job('old', { queuedAtMs: 0, basePriority: 0 }),
          job('new', { queuedAtMs: 1, basePriority: 100 }),
        ],
        'FCFS',
        [printer()],
        1,
      ),
    ).toEqual(['old', 'new']);
  });
  test('SCH-004 ignores page count', () => {
    expect(
      order(
        [
          job('long', { queuedAtMs: 0, pages: 100 }),
          job('short', { queuedAtMs: 1 }),
        ],
        'FCFS',
        [printer()],
        1,
      ),
    ).toEqual(['long', 'short']);
  });
});

describe('SJF', () => {
  test('SCH-005 orders by remaining service', () => {
    expect(
      order(
        [
          job('ten', { pages: 10 }),
          job('two', { pages: 2 }),
          job('six', { pages: 6 }),
        ],
        'SJF',
      ),
    ).toEqual(['two', 'six', 'ten']);
  });
  test('SCH-006 uses remaining pages', () => {
    expect(
      order(
        [
          job('nearly-done', { pages: 10, pagesCompleted: 9 }),
          job('new', { pages: 2 }),
        ],
        'SJF',
      ),
    ).toEqual(['nearly-done', 'new']);
  });
  test('SCH-007 uses an assigned compatible printer speed', () => {
    const printers = [
      printer({ id: 'slow', pagesPerMinute: 60 }),
      printer({ id: 'fast', pagesPerMinute: 120 }),
    ];
    const ranking = rankJobs(
      [
        job('slow-job', { pages: 2, assignedPrinterId: 'slow' }),
        job('fast-job', { pages: 3, assignedPrinterId: 'fast' }),
      ],
      printers,
      config('SJF'),
      0,
    );
    expect(
      ranking.decisions.map((decision) => [
        decision.jobId,
        decision.predictedServiceMs,
      ]),
    ).toEqual([
      ['fast-job', 1_500],
      ['slow-job', 2_000],
    ]);
  });
  test('SCH-008 breaks equal bursts by arrival then sequence', () => {
    expect(
      order(
        [
          job('later', { queuedAtMs: 1, sequence: 1 }),
          job('third', { sequence: 3 }),
          job('second', { sequence: 2 }),
        ],
        'SJF',
        [printer()],
        1,
      ),
    ).toEqual(['second', 'third', 'later']);
  });
  test('SCH-009 excludes incompatible work and reports it blocked', () => {
    const result = rankJobs(
      [
        job('color', { colorMode: 'COLOR', pages: 1 }),
        job('mono', { pages: 2 }),
      ],
      [printer({ supportsColor: false })],
      config('SJF'),
      0,
    );
    expect(result.decisions.map((decision) => decision.jobId)).toEqual([
      'mono',
    ]);
    expect(result.blockedJobIds).toEqual(['color']);
  });
});

describe('Priority with Dynamic Aging', () => {
  test('SCH-010 selects the highest priority', () => {
    expect(
      order(
        [
          job('low', { basePriority: 10 }),
          job('high', { basePriority: 80 }),
          job('mid', { basePriority: 50 }),
        ],
        'PRIORITY_AGING',
      ),
    ).toEqual(['high', 'mid', 'low']);
  });
  test('SCH-011 does not age before the first interval', () => {
    expect(
      effectivePriority(
        job('A', { basePriority: 20 }),
        4_999,
        config('PRIORITY_AGING'),
      ),
    ).toBe(20);
  });
  test('SCH-012 ages exactly at the interval boundary', () => {
    expect(
      effectivePriority(
        job('A', { basePriority: 20 }),
        5_000,
        config('PRIORITY_AGING'),
      ),
    ).toBe(22);
  });
  test('SCH-013 applies every complete interval', () => {
    expect(
      effectivePriority(
        job('A', { basePriority: 20 }),
        15_001,
        config('PRIORITY_AGING', { agingFactor: 3 }),
      ),
    ).toBe(29);
  });
  test('SCH-014 caps effective priority', () => {
    expect(
      effectivePriority(
        job('A', { basePriority: 95 }),
        5_000,
        config('PRIORITY_AGING', { agingFactor: 10 }),
      ),
    ).toBe(100);
  });
  test('SCH-015 treats negative derived wait as zero', () => {
    expect(
      effectivePriority(
        job('A', { basePriority: 20, queuedAtMs: 10_000 }),
        5_000,
        config('PRIORITY_AGING'),
      ),
    ).toBe(20);
  });
  test('SCH-016 breaks effective-priority ties by arrival then sequence', () => {
    expect(
      order(
        [
          job('new-high', { queuedAtMs: 5_000, basePriority: 30 }),
          job('old-low', { queuedAtMs: 0, basePriority: 28 }),
          job('old-low-2', { queuedAtMs: 0, basePriority: 28, sequence: 2 }),
        ],
        'PRIORITY_AGING',
        [printer()],
        5_000,
      ),
    ).toEqual(['old-low', 'old-low-2', 'new-high']);
  });
  test('SCH-017 derives all aging after missed ticks', () => {
    expect(
      effectivePriority(
        job('A', { basePriority: 20 }),
        50_000,
        config('PRIORITY_AGING'),
      ),
    ).toBe(40);
  });
  test('SCH-018 never mutates base priority', () => {
    const source = job('A', { basePriority: 20 });
    const before = structuredClone(source);
    effectivePriority(source, 50_000, config('PRIORITY_AGING'));
    effectivePriority(source, 100_000, config('PRIORITY_AGING'));
    expect(source).toEqual(before);
  });
});

describe('scheduler invariants and performance', () => {
  test('SCH-019 remains non-preemptive when an urgent job arrives', () => {
    const running = job('running', {
      status: 'PRINTING',
      assignedPrinterId: 'printer-1',
      startedAtMs: 0,
    });
    const urgent = job('urgent', { basePriority: 100, queuedAtMs: 1 });
    const snapshot = structuredClone(running);
    expect(order([running, urgent], 'PRIORITY_AGING', [printer()], 1)).toEqual([
      'urgent',
    ]);
    expect(running).toEqual(snapshot);
  });
  test('SCH-020 returns no selection for an empty eligible set', () => {
    expect(selectNextJob([], [printer()], config('FCFS'), 0)).toEqual({
      selected: null,
      blockedJobIds: [],
    });
  });
  test('SCH-021 produces identical results and explanations repeatedly', () => {
    const jobs = [
      job('C', { sequence: 3 }),
      job('A', { sequence: 1 }),
      job('B', { sequence: 2 }),
    ];
    const expected = JSON.stringify(
      rankJobs(jobs, [printer()], config('FCFS'), 0),
    );
    for (let run = 0; run < 100; run += 1) {
      expect(
        JSON.stringify(rankJobs(jobs, [printer()], config('FCFS'), 0)),
      ).toBe(expected);
    }
    expect(
      rankJobs(jobs, [printer()], config('FCFS'), 0).decisions[0]?.explanation,
    ).toMatchObject({
      algorithm: 'FCFS',
      rank: 1,
      criterion: 'arrival',
      tieBreakers: ['queuedAtMs', 'sequence'],
    });
  });
  test('SCH-022 selects from 10,000 jobs within the 50 ms budget', () => {
    const jobs = Array.from({ length: 10_000 }, (_, index) =>
      job(`job-${index + 1}`, { pages: 10_000 - index, sequence: index + 1 }),
    );
    selectNextJob(jobs, [printer()], config('SJF'), 0);
    const startedAt = performance.now();
    const result = selectNextJob(jobs, [printer()], config('SJF'), 0);
    const durationMs = performance.now() - startedAt;
    expect(result.selected?.jobId).toBe('job-10000');
    expect(durationMs).toBeLessThan(50);
  });
});
