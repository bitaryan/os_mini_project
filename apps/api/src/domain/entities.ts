import type {
  JobStatus,
  PrinterStatus,
  SchedulingAlgorithm,
  SpeedMultiplier,
} from '@printer/contracts';

export interface PrintJob {
  readonly id: string;
  readonly ownerId: string;
  readonly documentName: string;
  readonly pages: number;
  readonly pagesCompleted: number;
  readonly basePriority: number;
  readonly colorMode: 'MONO' | 'COLOR';
  readonly duplex: boolean;
  readonly status: JobStatus;
  readonly submittedAtMs: number;
  readonly queuedAtMs: number;
  readonly startedAtMs?: number;
  readonly completedAtMs?: number;
  readonly assignedPrinterId?: string;
  readonly cancellationRequestedAtMs?: number;
  readonly lastProgressAtMs?: number;
  readonly retryCount: number;
  readonly sequence: number;
  readonly version: number;
}

export interface PrinterProfile {
  readonly id: string;
  readonly status: PrinterStatus;
  readonly pagesPerMinute: number;
  readonly supportsColor: boolean;
  readonly supportsDuplex: boolean;
}

export interface DomainSchedulerConfig {
  readonly algorithm: SchedulingAlgorithm;
  readonly agingIntervalMs: number;
  readonly agingFactor: number;
  readonly priorityCap: number;
}

export interface SimulationClockState {
  readonly simulationTimeMs: number;
  readonly speedMultiplier: SpeedMultiplier;
  readonly paused: boolean;
}

export const isTerminalStatus = (status: JobStatus): boolean =>
  status === 'COMPLETED' || status === 'CANCELLED' || status === 'FAILED';
