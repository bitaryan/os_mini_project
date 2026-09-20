import { randomUUID } from 'node:crypto';
import { DomainError } from '../errors.js';

export interface MutexInspection {
  readonly locked: boolean;
  readonly ownerId?: string;
  readonly ownerToken?: string;
  readonly waiters: number;
}

export interface MutexHandle {
  readonly ownerId: string;
  readonly token: string;
  release(): void;
}

interface Waiter {
  readonly ownerId: string;
  readonly resolve: (handle: MutexHandle) => void;
  readonly reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class FairMutex {
  #owner: { ownerId: string; token: string } | undefined;
  readonly #waiters: Waiter[] = [];

  inspect(): MutexInspection {
    return this.#owner
      ? {
          locked: true,
          ownerId: this.#owner.ownerId,
          ownerToken: this.#owner.token,
          waiters: this.#waiters.length,
        }
      : { locked: false, waiters: this.#waiters.length };
  }

  acquire(ownerId: string, timeoutMs = 1_000): Promise<MutexHandle> {
    assertOwner(ownerId);
    assertTimeout(timeoutMs);
    if (!this.#owner) return Promise.resolve(this.#grant(ownerId));
    if (timeoutMs === 0) {
      return Promise.reject(
        new DomainError('RESOURCE_BUSY', 'Mutex acquisition timed out.'),
      );
    }

    return new Promise<MutexHandle>((resolve, reject) => {
      const waiter: Waiter = { ownerId, resolve, reject };
      waiter.timer = setTimeout(() => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(
          new DomainError('RESOURCE_BUSY', 'Mutex acquisition timed out.'),
        );
      }, timeoutMs);
      this.#waiters.push(waiter);
    });
  }

  async runExclusive<T>(
    ownerId: string,
    action: () => T | Promise<T>,
    timeoutMs = 1_000,
  ): Promise<T> {
    const handle = await this.acquire(ownerId, timeoutMs);
    try {
      return await action();
    } finally {
      handle.release();
    }
  }

  #grant(ownerId: string): MutexHandle {
    const token = randomUUID();
    this.#owner = { ownerId, token };
    let released = false;
    return {
      ownerId,
      token,
      release: () => {
        if (released) {
          throw new DomainError(
            'LOCK_NOT_OWNED',
            'This mutex handle was already released.',
          );
        }
        if (this.#owner?.token !== token) {
          throw new DomainError(
            'LOCK_NOT_OWNED',
            'Only the current mutex owner may release it.',
          );
        }
        released = true;
        this.#owner = undefined;
        this.#grantNext();
      },
    };
  }

  #grantNext(): void {
    const waiter = this.#waiters.shift();
    if (!waiter) return;
    clearTimeout(waiter.timer);
    waiter.resolve(this.#grant(waiter.ownerId));
  }
}

function assertOwner(ownerId: string): void {
  if (!ownerId.trim()) throw new TypeError('A mutex owner ID is required.');
}

function assertTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
    throw new RangeError('Mutex timeout must be a non-negative integer.');
  }
}
