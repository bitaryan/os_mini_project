import { DomainError } from '../errors.js';

export type BurstMode = 'ATOMIC' | 'AVAILABLE_CAPACITY';

export interface BurstPushResult<T> {
  readonly accepted: readonly T[];
  readonly rejected: readonly T[];
}

export class BoundedBuffer<T> {
  readonly #items = new Map<string, T>();
  #capacity: number;

  constructor(
    capacity: number,
    readonly keyOf: (item: T) => string,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError('Buffer capacity must be a positive integer.');
    }
    this.#capacity = capacity;
  }

  get capacity(): number {
    return this.#capacity;
  }

  get size(): number {
    return this.#items.size;
  }

  has(key: string): boolean {
    return this.#items.has(key);
  }

  snapshot(): readonly T[] {
    return [...this.#items.values()];
  }

  push(item: T): void {
    this.pushBurst([item], 'ATOMIC');
  }

  pushBurst(items: readonly T[], mode: BurstMode): BurstPushResult<T> {
    const keys = items.map(this.keyOf);
    if (
      new Set(keys).size !== keys.length ||
      keys.some((key) => this.#items.has(key))
    ) {
      throw new DomainError(
        'INVARIANT_VIOLATION',
        'Buffer items must have unique keys.',
      );
    }
    const available = this.capacity - this.size;
    if (mode === 'ATOMIC' && items.length > available) {
      throw new DomainError(
        'QUEUE_CAPACITY_EXCEEDED',
        'The active queue does not have enough capacity.',
      );
    }
    const accepted = items.slice(0, available);
    const rejected = items.slice(available);
    for (const item of accepted) this.#items.set(this.keyOf(item), item);
    return { accepted, rejected };
  }

  remove(key: string): T | undefined {
    const item = this.#items.get(key);
    this.#items.delete(key);
    return item;
  }

  resize(capacity: number): void {
    if (!Number.isSafeInteger(capacity) || capacity < this.size) {
      throw new DomainError(
        'QUEUE_CAPACITY_EXCEEDED',
        'Queue capacity cannot be lower than current use.',
      );
    }
    this.#capacity = capacity;
  }

  clear(): void {
    this.#items.clear();
  }
}
