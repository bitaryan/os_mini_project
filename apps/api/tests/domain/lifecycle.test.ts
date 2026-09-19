import { describe, expect, test } from 'vitest';
import type { PrintJob } from '../../src/domain/index.js';
import {
  InvalidJobTransitionError,
  assertJobInvariants,
  canTransition,
  transitionJob,
} from '../../src/domain/index.js';

const readyJob = (): PrintJob => ({
  id: 'job-1',
  ownerId: 'owner-1',
  documentName: 'Lecture notes',
  pages: 2,
  pagesCompleted: 0,
  basePriority: 50,
  colorMode: 'MONO',
  duplex: false,
  status: 'READY',
  submittedAtMs: 0,
  queuedAtMs: 0,
  retryCount: 0,
  sequence: 1,
  version: 0,
});

describe('job lifecycle', () => {
  test('defines the complete legal transition table', () => {
    const expected = {
      QUEUED: ['READY', 'CANCELLED'],
      READY: ['PRINTING', 'BLOCKED', 'CANCELLED', 'FAILED'],
      PRINTING: ['PAUSED', 'COMPLETED', 'CANCELLED', 'FAILED'],
      PAUSED: ['PRINTING', 'READY', 'CANCELLED', 'FAILED'],
      BLOCKED: ['READY', 'CANCELLED'],
      COMPLETED: [],
      CANCELLED: [],
      FAILED: [],
    } as const;
    for (const [from, allowed] of Object.entries(expected)) {
      for (const to of Object.keys(expected)) {
        expect(
          canTransition(
            from as keyof typeof expected,
            to as keyof typeof expected,
          ),
        ).toBe(allowed.includes(to as never));
      }
    }
  });

  test('returns a new job for a legal transition and leaves the source unchanged', () => {
    const source = readyJob();
    const printing = transitionJob(source, 'PRINTING', {
      assignedPrinterId: 'printer-1',
      startedAtMs: 10,
      lastProgressAtMs: 10,
    });
    expect(printing).toMatchObject({
      status: 'PRINTING',
      version: 1,
      assignedPrinterId: 'printer-1',
    });
    expect(source).toEqual(readyJob());

    const completed = transitionJob(printing, 'COMPLETED', {
      pagesCompleted: 2,
      completedAtMs: 2_010,
      assignedPrinterId: null,
    });
    expect(completed).toMatchObject({
      status: 'COMPLETED',
      pagesCompleted: 2,
      version: 2,
    });
    expect(completed).not.toHaveProperty('assignedPrinterId');
  });

  test('rejects illegal and terminal transitions', () => {
    expect(canTransition('READY', 'PRINTING')).toBe(true);
    expect(canTransition('READY', 'COMPLETED')).toBe(false);
    expect(() => transitionJob(readyJob(), 'COMPLETED')).toThrow(
      InvalidJobTransitionError,
    );
    const cancelled = transitionJob(readyJob(), 'CANCELLED');
    expect(() => transitionJob(cancelled, 'READY')).toThrow(
      InvalidJobTransitionError,
    );
  });

  test.each([
    { pages: 0 },
    { pages: 10_001 },
    { pagesCompleted: 3 },
    { pages: 2, pagesCompleted: 2 },
    { basePriority: -1 },
    { basePriority: 101 },
    { documentName: ' ' },
    { queuedAtMs: -1 },
    { startedAtMs: -1 },
    { status: 'PRINTING' as const },
    { status: 'COMPLETED' as const, pagesCompleted: 2 },
    { status: 'CANCELLED' as const, assignedPrinterId: 'printer-1' },
  ])('rejects invalid job state %j', (patch) => {
    expect(() => assertJobInvariants({ ...readyJob(), ...patch })).toThrow();
  });
});
