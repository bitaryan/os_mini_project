import { describe, expect, test } from 'vitest';
import {
  BinaryLeaseMutex,
  BoundedBuffer,
  CountingSemaphore,
  DomainError,
  FairMutex,
} from '../../src/domain/index.js';

describe('synchronization primitives', () => {
  test('SYN-001 permits one printer owner and bounds a competing acquire', async () => {
    const mutex = new BinaryLeaseMutex(() => 0);
    const first = await mutex.acquire('worker-a', 100, 0);
    await expect(mutex.acquire('worker-b', 100, 0)).rejects.toMatchObject({
      code: 'RESOURCE_BUSY',
    });
    expect(mutex.inspect()).toMatchObject({
      locked: true,
      ownerWorkerId: 'worker-a',
    });
    first.release();
  });

  test('SYN-002 allows different printer mutexes concurrently', async () => {
    const first = new BinaryLeaseMutex(() => 0);
    const second = new BinaryLeaseMutex(() => 0);
    const [left, right] = await Promise.all([
      first.acquire('worker-a', 100, 0),
      second.acquire('worker-b', 100, 0),
    ]);
    expect(first.inspect().locked).toBe(true);
    expect(second.inspect().locked).toBe(true);
    left.release();
    right.release();
  });

  test('SYN-003 grants fair mutex waiters in FIFO order', async () => {
    const mutex = new FairMutex();
    const first = await mutex.acquire('a', 0);
    const order: string[] = [];
    const second = mutex.acquire('b').then((handle) => {
      order.push('b');
      handle.release();
    });
    const third = mutex.acquire('c').then((handle) => {
      order.push('c');
      handle.release();
    });
    first.release();
    await Promise.all([second, third]);
    expect(order).toEqual(['b', 'c']);
  });

  test('SYN-004 runExclusive releases after a failure', async () => {
    const mutex = new FairMutex();
    await expect(
      mutex.runExclusive('failing-worker', () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const next = await mutex.acquire('next-worker', 0);
    next.release();
  });

  test('SYN-005 rejects a double semaphore release without permit drift', () => {
    const semaphore = new CountingSemaphore(1);
    const permit = semaphore.tryAcquire();
    expect(permit).not.toBeNull();
    permit?.release();
    expect(() => permit?.release()).toThrow(DomainError);
    expect(semaphore.inspect().permits).toBe(1);
  });

  test('SYN-006 rejects release by a non-owner', async () => {
    const mutex = new BinaryLeaseMutex(() => 0);
    const lease = await mutex.acquire('owner', 100, 0);
    expect(() => mutex.assertOwned('not-the-lease', lease.fenceToken)).toThrow(
      expect.objectContaining({ code: 'LOCK_NOT_OWNED' }),
    );
    lease.release();
  });

  test('SYN-007 fences stale progress tokens', async () => {
    let nowMs = 0;
    const mutex = new BinaryLeaseMutex(() => nowMs);
    const lease = await mutex.acquire('stale-worker', 10, 0);
    nowMs = 10;
    expect(mutex.fenceExpired(lease.leaseId, lease.fenceToken)).toBe(1);
    expect(() => mutex.assertOwned(lease.leaseId, lease.fenceToken)).toThrow(
      expect.objectContaining({ code: 'FENCE_TOKEN_MISMATCH' }),
    );
  });

  test('SYN-008 refuses forced release before lease expiry', async () => {
    const mutex = new BinaryLeaseMutex(() => 0);
    const lease = await mutex.acquire('worker', 10, 0);
    expect(() => mutex.fenceExpired(lease.leaseId, lease.fenceToken)).toThrow(
      expect.objectContaining({ code: 'RESOURCE_BUSY' }),
    );
    lease.release();
  });

  test('SYN-009 releases an expired fenced lease exactly once', async () => {
    let nowMs = 0;
    const mutex = new BinaryLeaseMutex(() => nowMs);
    const lease = await mutex.acquire('worker', 10, 0);
    nowMs = 10;
    mutex.fenceExpired(lease.leaseId, lease.fenceToken);
    expect(mutex.inspect()).toMatchObject({ locked: false, fenceToken: 1 });
    expect(() => mutex.fenceExpired(lease.leaseId, lease.fenceToken)).toThrow();
    const recovered = await mutex.acquire('recovered-worker', 10, 0);
    expect(recovered.fenceToken).toBe(1);
    recovered.release();
  });

  test('renews an owned lease from the current monotonic time', async () => {
    let nowMs = 0;
    const mutex = new BinaryLeaseMutex(() => nowMs);
    const lease = await mutex.acquire('worker', 10, 0);
    nowMs = 5;
    lease.renew(20);
    nowMs = 24;
    expect(() =>
      mutex.assertOwned(lease.leaseId, lease.fenceToken),
    ).not.toThrow();
    lease.release();
  });

  test('SYN-010 never allows negative semaphore permits', async () => {
    const semaphore = new CountingSemaphore(1);
    const permit = await semaphore.acquire(0);
    await expect(semaphore.acquire(0)).rejects.toMatchObject({
      code: 'RESOURCE_BUSY',
    });
    expect(semaphore.inspect().permits).toBe(0);
    permit.release();
  });

  test('supports atomic and explicit partial bounded-buffer bursts', () => {
    const buffer = new BoundedBuffer<string>(2, (value) => value);
    buffer.push('a');
    expect(() => buffer.pushBurst(['b', 'c'], 'ATOMIC')).toThrow(
      expect.objectContaining({ code: 'QUEUE_CAPACITY_EXCEEDED' }),
    );
    expect(buffer.snapshot()).toEqual(['a']);
    expect(buffer.pushBurst(['b', 'c'], 'AVAILABLE_CAPACITY')).toEqual({
      accepted: ['b'],
      rejected: ['c'],
    });
  });
});
