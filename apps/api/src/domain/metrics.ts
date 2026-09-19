export interface JobTimingInput {
  readonly arrivalMs: number;
  readonly firstStartMs: number;
  readonly completionMs: number;
  readonly serviceMs: number;
}

export interface JobTiming {
  readonly responseMs: number;
  readonly waitMs: number;
  readonly serviceMs: number;
  readonly turnaroundMs: number;
}

export interface DistributionSummary {
  readonly average: number | null;
  readonly median: number | null;
  readonly p95: number | null;
}

export function calculateJobTiming(input: JobTimingInput): JobTiming {
  const values = [
    input.arrivalMs,
    input.firstStartMs,
    input.completionMs,
    input.serviceMs,
  ];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError('Timing values must be non-negative safe integers.');
  }
  if (
    input.firstStartMs < input.arrivalMs ||
    input.completionMs < input.firstStartMs
  ) {
    throw new RangeError('Job timestamps must follow lifecycle order.');
  }
  const turnaroundMs = input.completionMs - input.arrivalMs;
  if (input.serviceMs > turnaroundMs) {
    throw new RangeError('Service time cannot exceed turnaround time.');
  }
  return {
    responseMs: input.firstStartMs - input.arrivalMs,
    waitMs: turnaroundMs - input.serviceMs,
    serviceMs: input.serviceMs,
    turnaroundMs,
  };
}

export function summarize(values: readonly number[]): DistributionSummary {
  if (values.length === 0) return { average: null, median: null, p95: null };
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new RangeError('Metric samples must be finite and non-negative.');
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? (sorted[middle] as number)
      : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
  return {
    average: values.reduce((total, value) => total + value, 0) / values.length,
    median,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1] as number,
  };
}

export function throughputJobsPerMinute(
  completedJobs: number,
  elapsedSimulationMs: number,
): number | null {
  if (!Number.isSafeInteger(completedJobs) || completedJobs < 0) {
    throw new RangeError(
      'Completed job count must be a non-negative safe integer.',
    );
  }
  assertDuration(elapsedSimulationMs);
  return elapsedSimulationMs === 0
    ? null
    : (completedJobs * 60_000) / elapsedSimulationMs;
}

export function fairnessIndex(waitTimesMs: readonly number[]): number | null {
  if (waitTimesMs.length === 0) return null;
  if (waitTimesMs.some((wait) => !Number.isFinite(wait) || wait < 0)) {
    throw new RangeError('Wait times must be finite and non-negative.');
  }
  const scores = waitTimesMs.map((wait) => 1 / (1 + wait));
  const total = scores.reduce((sum, score) => sum + score, 0);
  const squares = scores.reduce((sum, score) => sum + score * score, 0);
  return (total * total) / (scores.length * squares);
}

export function printerUtilization(
  busyMs: number,
  onlineMs: number,
): number | null {
  assertDuration(busyMs);
  assertDuration(onlineMs);
  if (busyMs > onlineMs)
    throw new RangeError('Busy time cannot exceed online time.');
  return onlineMs === 0 ? null : busyMs / onlineMs;
}

function assertDuration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('Durations must be non-negative safe integers.');
  }
}
