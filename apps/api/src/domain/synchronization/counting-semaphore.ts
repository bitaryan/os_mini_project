import { randomUUID } from 'node:crypto';
import { DomainError } from '../errors.js';

export interface SemaphoreInspection {
  readonly permits: number;
  readonly maximumPermits: number;
  readonly waiters: number;
}

export interface SemaphorePermit {
  readonly token: string;
  release(): void;
}

interface PermitWaiter {
  readonly resolve: (permit: SemaphorePermit) => void;
  readonly reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class CountingSemaphore {
  #permits: number;
  #maximumPermits: number;
  readonly #active = new Set<string>();
  readonly #waiters: PermitWaiter[] = [];

  constructor(maximumPermits: number, initialPermits = maximumPermits) {
    if (!Number.isSafeInteger(maximumPermits) || maximumPermits < 0) {
      throw new RangeError('Maximum permits must be a non-negative integer.');
    }
    if (
      !Number.isSafeInteger(initialPermits) ||
      initialPermits < 0 ||
      initialPermits > maximumPermits
    ) {
      throw new RangeError('Initial permits exceed semaphore bounds.');
    }
    this.#maximumPermits = maximumPermits;
    this.#permits = initialPermits;
  }

  get maximumPermits(): number {
    return this.#maximumPermits;
  }

  inspect(): SemaphoreInspection {
    return {
      permits: this.#permits,
      maximumPermits: this.maximumPermits,
      waiters: this.#waiters.length,
    };
  }

  tryAcquire(): SemaphorePermit | null {
    return this.#permits === 0 ? null : this.#grant();
  }

  acquire(timeoutMs = 1_000): Promise<SemaphorePermit> {
    assertTimeout(timeoutMs);
    const permit = this.tryAcquire();
    if (permit) return Promise.resolve(permit);
    if (timeoutMs === 0) {
      return Promise.reject(
        new DomainError('RESOURCE_BUSY', 'No semaphore permit is available.'),
      );
    }
    return new Promise<SemaphorePermit>((resolve, reject) => {
      const waiter: PermitWaiter = { resolve, reject };
      waiter.timer = setTimeout(() => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(
          new DomainError('RESOURCE_BUSY', 'Semaphore acquisition timed out.'),
        );
      }, timeoutMs);
      this.#waiters.push(waiter);
    });
  }

  addAvailableSlot(): void {
    this.#maximumPermits += 1;
    this.#permits += 1;
  }

  #grant(): SemaphorePermit {
    if (this.#permits === 0) {
      throw new DomainError(
        'RESOURCE_BUSY',
        'No semaphore permit is available.',
      );
    }
    this.#permits -= 1;
    const token = randomUUID();
    this.#active.add(token);
    let released = false;
    return {
      token,
      release: () => {
        if (released || !this.#active.delete(token)) {
          throw new DomainError(
            'LOCK_NOT_OWNED',
            'This semaphore permit was already released.',
          );
        }
        released = true;
        const waiter = this.#waiters.shift();
        if (waiter) {
          clearTimeout(waiter.timer);
          this.#permits += 1;
          waiter.resolve(this.#grant());
          return;
        }
        this.#permits += 1;
        if (this.#permits > this.maximumPermits) {
          throw new DomainError(
            'INVARIANT_VIOLATION',
            'Semaphore permit count exceeded its bound.',
          );
        }
      },
    };
  }
}

function assertTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
    throw new RangeError('Semaphore timeout must be a non-negative integer.');
  }
}
