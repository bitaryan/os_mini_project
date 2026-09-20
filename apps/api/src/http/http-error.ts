import type { ErrorCode } from '@printer/contracts';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly retryable = false,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
