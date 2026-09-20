import { describe, expect, test } from 'vitest';
import type { JobSubmission, PrinterState } from '../../src/domain/index.js';
import {
  PrinterWorkerPool,
  QueueCoordinator,
  SimulationClock,
} from '../../src/domain/index.js';

const printer = (
  id: string,
  overrides: Partial<PrinterState> = {},
): PrinterState => ({
  id,
  name: id,
  status: 'READY',
  pagesPerMinute: 60,
  supportsColor: true,
  supportsDuplex: true,
  version: 0,
  ...overrides,
});
const submission = (
  id: string,
  pages = 1,
  overrides: Partial<JobSubmission['input']> = {},
): JobSubmission => ({
  id,
  ownerId: 'owner',
  input: {
    documentName: id,
    pages,
    basePriority: 50,
    colorMode: 'MONO',
    duplex: false,
    arrivalDelayMs: 0,
    ...overrides,
  },
});
const coordinator = (
  printers: readonly PrinterState[] = [printer('printer-1')],
  capacity = 10,
) =>
  new QueueCoordinator(
    new SimulationClock(),
    {
      algorithm: 'FCFS',
      agingIntervalMs: 5_000,
      agingFactor: 2,
      priorityCap: 100,
    },
    printers,
    capacity,
  );

describe('queue coordinator and printer workers', () => {
  test('SYN-011 completion returns exactly one printer permit', async () => {
    const system = coordinator();
    await system.submitJob({ commandId: 'submit' }, submission('job'));
    const assignment = await system.dispatch(
      { commandId: 'dispatch' },
      'printer-1',
    );
    expect(system.snapshot().availablePrinterPermits).toBe(0);
    system.clock.advanceSimulationBy(1_000);
    await system.advancePage(
      { commandId: 'page' },
      'printer-1',
      assignment!.lease.leaseId,
      assignment!.lease.fenceToken,
    );
    expect(system.snapshot().availablePrinterPermits).toBe(1);
    await expect(
      system.cancelJob({ commandId: 'late-cancel' }, 'job'),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(system.snapshot().availablePrinterPermits).toBe(1);
  });

  test('SYN-012 active cancellation stops after one committed page', async () => {
    const system = coordinator();
    await system.submitJob({ commandId: 'submit' }, submission('job', 3));
    const assignment = await system.dispatch(
      { commandId: 'dispatch' },
      'printer-1',
    );
    await system.cancelJob({ commandId: 'cancel' }, 'job');
    system.clock.advanceSimulationBy(1_000);
    const result = await system.advancePage(
      { commandId: 'page' },
      'printer-1',
      assignment!.lease.leaseId,
      assignment!.lease.fenceToken,
    );
    expect(result.job).toMatchObject({
      status: 'CANCELLED',
      pagesCompleted: 1,
    });
    expect(system.snapshot().availablePrinterPermits).toBe(1);
  });

  test('SYN-013 and SYN-014 remove and restore one idle-printer permit', async () => {
    const system = coordinator([printer('p1'), printer('p2')]);
    await system.setPrinterOnline({ commandId: 'offline' }, 'p1', false);
    expect(system.snapshot().availablePrinterPermits).toBe(1);
    await system.setPrinterOnline({ commandId: 'online' }, 'p1', true);
    expect(system.snapshot().availablePrinterPermits).toBe(2);
  });

  test('SYN-015 enforces queue-before-printer through the coordinator boundary', async () => {
    const system = coordinator();
    await system.submitJob({ commandId: 'submit' }, submission('job'));
    await system.dispatch({ commandId: 'dispatch' }, 'printer-1');
    const state = system.snapshot();
    expect(state.queueMutex.locked).toBe(false);
    expect(state.printers[0]?.mutex.locked).toBe(true);
    system.assertInvariants();
  });

  test('SYN-016 lets only one producer consume the final buffer slot', async () => {
    const system = coordinator([printer('p')], 1);
    const outcomes = await Promise.allSettled([
      system.submitJob({ commandId: 'a' }, submission('a')),
      system.submitJob({ commandId: 'b' }, submission('b')),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === 'rejected'),
    ).toHaveLength(1);
    expect(system.snapshot().activeBufferJobIds).toHaveLength(1);
  });

  test('SYN-017 rejects the second command built on one state version', async () => {
    const system = coordinator();
    await system.submitJob(
      { commandId: 'first', expectedStateVersion: 0 },
      submission('first'),
    );
    await expect(
      system.submitJob(
        { commandId: 'second', expectedStateVersion: 0 },
        submission('second'),
      ),
    ).rejects.toMatchObject({ code: 'STATE_VERSION_CONFLICT' });
  });

  test('SYN-018 buffers events until after each critical section', async () => {
    const system = coordinator();
    await system.submitJob({ commandId: 'submit' }, submission('job'));
    expect(system.snapshot().queueMutex.locked).toBe(false);
    expect(system.drainEvents().map((event) => event.type)).toEqual([
      'JOB_SUBMITTED',
      'AUDIT_ENTRY_CREATED',
    ]);
  });

  test('replays a command ID without repeating its side effect', async () => {
    const system = coordinator();
    const meta = { commandId: 'same-command', expectedStateVersion: 0 };
    const first = await system.submitJob(meta, submission('job'));
    const replay = await system.submitJob(meta, submission('job'));
    expect(replay).toEqual(first);
    expect(system.snapshot()).toMatchObject({
      stateVersion: 1,
      activeBufferJobIds: ['job'],
    });
  });

  test('blocks incompatible jobs and makes them ready when capacity returns', async () => {
    const system = coordinator([
      printer('color-printer', { supportsColor: true, status: 'OFFLINE' }),
    ]);
    expect(
      await system.submitJob(
        { commandId: 'submit' },
        submission('color', 1, { colorMode: 'COLOR' }),
      ),
    ).toMatchObject({ status: 'BLOCKED' });
    await system.setPrinterOnline(
      { commandId: 'online' },
      'color-printer',
      true,
    );
    expect(system.snapshot().jobs[0]).toMatchObject({ status: 'READY' });
  });

  test('runs two printers concurrently and finishes without leaked resources', async () => {
    const system = coordinator([printer('p1'), printer('p2')]);
    await system.submitBurst(
      { commandId: 'burst' },
      [submission('a', 3), submission('b', 2), submission('c', 4)],
      'ATOMIC',
    );
    const final = await new PrinterWorkerPool(system).runUntilIdle();
    expect(final.jobs.map((job) => job.status)).toEqual([
      'COMPLETED',
      'COMPLETED',
      'COMPLETED',
    ]);
    expect(final.activeBufferJobIds).toEqual([]);
    expect(final.availablePrinterPermits).toBe(2);
    expect(final.printers.every((item) => !item.mutex.locked)).toBe(true);
    expect(system.clock.state.simulationTimeMs).toBe(6_000);
  });

  test('does not dispatch or advance work while simulation time is paused', async () => {
    const system = coordinator();
    await system.submitJob({ commandId: 'submit' }, submission('job'));
    system.clock.pause();
    const paused = await new PrinterWorkerPool(system).runUntilIdle();
    expect(paused.jobs[0]).toMatchObject({
      status: 'READY',
      pagesCompleted: 0,
    });
    expect(paused.availablePrinterPermits).toBe(1);
  });

  test('keeps 1,000 jobs unique across 64 concurrent printer workers', async () => {
    const printers = Array.from({ length: 64 }, (_, index) =>
      printer(`p-${index.toString().padStart(2, '0')}`),
    );
    const system = coordinator(printers, 1_000);
    await system.submitBurst(
      { commandId: 'stress-burst' },
      Array.from({ length: 1_000 }, (_, index) => submission(`job-${index}`)),
      'ATOMIC',
    );
    const final = await new PrinterWorkerPool(system).runUntilIdle();
    expect(final.jobs.filter((job) => job.status === 'COMPLETED')).toHaveLength(
      1_000,
    );
    expect(new Set(final.jobs.map((job) => job.id)).size).toBe(1_000);
    expect(final.availablePrinterPermits).toBe(64);
    expect(final.printers.every((item) => !item.mutex.locked)).toBe(true);
  });
});
