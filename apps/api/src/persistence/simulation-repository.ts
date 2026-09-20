import type { CoordinatorState, DomainEvent } from '../domain/index.js';
import type { AuditEntry } from '@printer/contracts';

export interface AuditRecord {
  readonly id?: string;
  readonly actorKind: 'USER' | 'AGENT' | 'SYSTEM';
  readonly actorId: string;
  readonly commandType: string;
  readonly correlationId: string;
  readonly stateVersionBefore: number;
  readonly stateVersionAfter: number;
  readonly outcome: 'ACCEPTED' | 'REJECTED' | 'FAILED';
  readonly reasonCode?: string;
  readonly redactedParameters: Readonly<Record<string, unknown>>;
  readonly durationMs: number;
}

export interface IdempotencyRecord {
  readonly actorId: string;
  readonly routeKey: string;
  readonly key: string;
  readonly requestHash: string;
  readonly statusCode: number;
  readonly response: unknown;
}

export interface PersistedIdempotencyResult {
  readonly requestHash: string;
  readonly statusCode: number;
  readonly response: unknown;
}

export interface PersistedEvent {
  readonly outboxId?: string;
  readonly eventId: string;
  readonly simulationId: string;
  readonly stateVersion: number;
  readonly eventIndex: number;
  readonly type: string;
  readonly simulationTimeMs: number;
  readonly correlationId?: string;
  readonly occurredAt: string;
  readonly payload: DomainEvent;
}

export interface StateCommit {
  readonly simulationId: string;
  readonly expectedStateVersion: number | null;
  readonly state: CoordinatorState;
  readonly events: readonly DomainEvent[];
  readonly audit: AuditRecord;
  readonly idempotency?: IdempotencyRecord;
}

export interface BenchmarkRecord {
  readonly id: string;
  readonly simulationId: string;
  readonly workloadHash: string;
  readonly status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  readonly request: unknown;
  readonly result?: unknown;
  readonly actorId?: string;
  readonly correlationId?: string;
}

export interface AuditQuery {
  readonly from?: string;
  readonly to?: string;
  readonly actorId?: string;
  readonly actorKind?: 'USER' | 'AGENT' | 'SYSTEM';
  readonly commandType?: string;
  readonly outcome?: 'ACCEPTED' | 'REJECTED' | 'FAILED';
  readonly correlationId?: string;
}

export interface SimulationRepository {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isReady(): Promise<boolean>;
  load(simulationId: string): Promise<CoordinatorState | null>;
  loadVersion(
    simulationId: string,
    stateVersion: number,
  ): Promise<CoordinatorState | null>;
  findIdempotency(
    actorId: string,
    routeKey: string,
    key: string,
  ): Promise<PersistedIdempotencyResult | null>;
  commit(commit: StateCommit): Promise<void>;
  readUndelivered(limit: number): Promise<readonly PersistedEvent[]>;
  readEventsAfter(
    simulationId: string,
    stateVersion: number,
    eventIndex: number,
    limit: number,
  ): Promise<readonly PersistedEvent[]>;
  readEventsThrough(
    simulationId: string,
    toMs: number,
    limit: number,
  ): Promise<readonly PersistedEvent[]>;
  saveBenchmark(record: BenchmarkRecord): Promise<void>;
  readBenchmark(
    simulationId: string,
    benchmarkId: string,
  ): Promise<BenchmarkRecord | null>;
  readAudit(
    simulationId: string,
    query: AuditQuery,
    offset: number,
    limit: number,
  ): Promise<{
    readonly items: readonly AuditEntry[];
    readonly hasMore: boolean;
  }>;
  markDelivered(outboxIds: readonly string[]): Promise<void>;
}
