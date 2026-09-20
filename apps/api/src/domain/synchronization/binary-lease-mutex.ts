import { randomUUID } from 'node:crypto';
import { DomainError } from '../errors.js';

export interface LeaseInspection {
  readonly locked: boolean;
  readonly ownerWorkerId?: string;
  readonly leaseId?: string;
  readonly acquiredAtMs?: number;
  readonly expiresAtMs?: number;
  readonly fenceToken: number;
  readonly waiters: number;
}

export interface LeaseHandle {
  readonly ownerWorkerId: string;
  readonly leaseId: string;
  readonly fenceToken: number;
  renew(leaseDurationMs: number): void;
  release(): void;
}

interface LeaseOwner {
  readonly ownerWorkerId: string;
  readonly leaseId: string;
  readonly acquiredAtMs: number;
  expiresAtMs: number;
}

interface LeaseWaiter {
  readonly ownerWorkerId: string;
  readonly leaseDurationMs: number;
  readonly resolve: (lease: LeaseHandle) => void;
  readonly reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class BinaryLeaseMutex {
  #owner: LeaseOwner | undefined;
  #fenceToken = 0;
  readonly #waiters: LeaseWaiter[] = [];

  constructor(
    readonly now: () => number,
    initial?: LeaseInspection,
  ) {
    if (!initial) return;
    this.#fenceToken = initial.fenceToken;
    if (
      initial.locked &&
      initial.ownerWorkerId &&
      initial.leaseId &&
      initial.acquiredAtMs !== undefined &&
      initial.expiresAtMs !== undefined
    ) {
      this.#owner = {
        ownerWorkerId: initial.ownerWorkerId,
        leaseId: initial.leaseId,
        acquiredAtMs: initial.acquiredAtMs,
        expiresAtMs: initial.expiresAtMs,
      };
    }
  }

  restoredHandle(): LeaseHandle {
    if (!this.#owner) {
      throw new DomainError('LOCK_NOT_OWNED', 'No restored lease is active.');
    }
    return this.#handle(this.#owner);
  }

  inspect(): LeaseInspection {
    return this.#owner
      ? {
          locked: true,
          ownerWorkerId: this.#owner.ownerWorkerId,
          leaseId: this.#owner.leaseId,
          acquiredAtMs: this.#owner.acquiredAtMs,
          expiresAtMs: this.#owner.expiresAtMs,
          fenceToken: this.#fenceToken,
          waiters: this.#waiters.length,
        }
      : {
          locked: false,
          fenceToken: this.#fenceToken,
          waiters: this.#waiters.length,
        };
  }

  acquire(
    ownerWorkerId: string,
    leaseDurationMs: number,
    timeoutMs = 1_000,
  ): Promise<LeaseHandle> {
    if (!ownerWorkerId.trim()) throw new TypeError('A worker ID is required.');
    assertDuration(leaseDurationMs, 'Lease duration');
    assertDuration(timeoutMs, 'Lease acquisition timeout', true);
    if (!this.#owner) {
      return Promise.resolve(this.#grant(ownerWorkerId, leaseDurationMs));
    }
    if (timeoutMs === 0) {
      return Promise.reject(
        new DomainError('RESOURCE_BUSY', 'Printer mutex is already owned.'),
      );
    }
    return new Promise<LeaseHandle>((resolve, reject) => {
      const waiter: LeaseWaiter = {
        ownerWorkerId,
        leaseDurationMs,
        resolve,
        reject,
      };
      waiter.timer = setTimeout(() => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(
          new DomainError(
            'RESOURCE_BUSY',
            'Printer mutex acquisition timed out.',
          ),
        );
      }, timeoutMs);
      this.#waiters.push(waiter);
    });
  }

  assertOwned(leaseId: string, fenceToken: number): void {
    if (fenceToken !== this.#fenceToken) {
      throw new DomainError(
        'FENCE_TOKEN_MISMATCH',
        'The worker fence token is stale.',
      );
    }
    if (!this.#owner || this.#owner.leaseId !== leaseId) {
      throw new DomainError(
        'LOCK_NOT_OWNED',
        'The worker does not own this printer mutex.',
      );
    }
    if (this.now() >= this.#owner.expiresAtMs) {
      throw new DomainError('LEASE_EXPIRED', 'The printer lease has expired.');
    }
  }

  fenceExpired(leaseId: string, expectedFenceToken: number): number {
    if (expectedFenceToken !== this.#fenceToken) {
      throw new DomainError(
        'FENCE_TOKEN_MISMATCH',
        'The expected fence token does not match.',
      );
    }
    if (!this.#owner || this.#owner.leaseId !== leaseId) {
      throw new DomainError('LOCK_NOT_OWNED', 'The lease is not active.');
    }
    if (this.now() < this.#owner.expiresAtMs) {
      throw new DomainError(
        'RESOURCE_BUSY',
        'An unexpired printer lease cannot be force released.',
      );
    }
    this.#fenceToken += 1;
    this.#owner = undefined;
    this.#grantNext();
    return this.#fenceToken;
  }

  #grant(ownerWorkerId: string, leaseDurationMs: number): LeaseHandle {
    const leaseId = randomUUID();
    const acquiredAtMs = this.now();
    this.#owner = {
      ownerWorkerId,
      leaseId,
      acquiredAtMs,
      expiresAtMs: acquiredAtMs + leaseDurationMs,
    };
    return this.#handle(this.#owner);
  }

  #handle(owner: LeaseOwner): LeaseHandle {
    const { ownerWorkerId, leaseId } = owner;
    const fenceToken = this.#fenceToken;
    let released = false;
    return {
      ownerWorkerId,
      leaseId,
      fenceToken,
      renew: (durationMs) => {
        assertDuration(durationMs, 'Lease duration');
        this.assertOwned(leaseId, fenceToken);
        (this.#owner as LeaseOwner).expiresAtMs = this.now() + durationMs;
      },
      release: () => {
        if (released) {
          throw new DomainError(
            'LOCK_NOT_OWNED',
            'This printer lease was already released.',
          );
        }
        this.assertOwned(leaseId, fenceToken);
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
    waiter.resolve(this.#grant(waiter.ownerWorkerId, waiter.leaseDurationMs));
  }
}

function assertDuration(value: number, label: string, allowZero = false): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new RangeError(`${label} must be a positive integer.`);
  }
}
