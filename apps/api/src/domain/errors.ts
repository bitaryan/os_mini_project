export type DomainErrorCode =
  | 'FENCE_TOKEN_MISMATCH'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVARIANT_VIOLATION'
  | 'INVALID_TRANSITION'
  | 'JOB_VERSION_CONFLICT'
  | 'LEASE_EXPIRED'
  | 'LOCK_NOT_OWNED'
  | 'NO_COMPATIBLE_PRINTER'
  | 'PERSISTENCE_UNAVAILABLE'
  | 'QUEUE_CAPACITY_EXCEEDED'
  | 'RESOURCE_BUSY'
  | 'STATE_VERSION_CONFLICT';

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
