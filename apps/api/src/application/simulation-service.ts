import { createHash, randomUUID } from 'node:crypto';
import type { Role } from './types.js';
import {
  DomainError,
  FairMutex,
  QueueCoordinator,
  SimulationClock,
  type CommandMeta,
  type DomainEvent,
  type PrinterState,
} from '../domain/index.js';
import type {
  AuditRecord,
  IdempotencyRecord,
  SimulationRepository,
  StateCommit,
} from '../persistence/index.js';

export interface MutationContext {
  readonly actor: { readonly id: string; readonly role: Role };
  readonly actorKind?: AuditRecord['actorKind'];
  readonly correlationId: string;
  readonly commandType: string;
  readonly routeKey: string;
  readonly requestBody: unknown;
  readonly expectedStateVersion?: number;
  readonly idempotencyKey?: string;
  readonly statusCode: number;
  readonly redactedParameters?: Readonly<Record<string, unknown>>;
}

export interface MutationResult<T> {
  readonly value: T;
  readonly stateVersion: number;
  readonly statusCode: number;
  readonly replayed: boolean;
}

export interface CommitNotice {
  readonly simulationId: string;
  readonly state: ReturnType<QueueCoordinator['exportState']>;
  readonly events: readonly DomainEvent[];
}

export class SimulationService {
  readonly #coordinators = new Map<string, QueueCoordinator>();
  readonly #locks = new Map<string, FairMutex>();
  readonly #listeners = new Set<(notice: CommitNotice) => void>();
  readonly #stalledPrinters = new Map<string, Set<string>>();

  constructor(
    readonly repository: SimulationRepository,
    readonly defaults: {
      readonly queueCapacity: number;
      readonly algorithm: 'FCFS' | 'SJF' | 'PRIORITY_AGING';
      readonly agingIntervalMs: number;
      readonly agingFactor: number;
      readonly priorityCap: number;
      readonly workerLeaseMs: number;
    },
  ) {}

  async initialize(): Promise<void> {
    await this.repository.connect();
  }

  async close(): Promise<void> {
    await this.repository.disconnect();
  }

  async isReady(): Promise<boolean> {
    return this.repository.isReady();
  }

  onCommit(listener: (notice: CommitNotice) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  loadedSimulationIds(): readonly string[] {
    return [...this.#coordinators.keys()];
  }

  setPrinterStalled(
    simulationId: string,
    printerId: string,
    stalled: boolean,
  ): void {
    const printers =
      this.#stalledPrinters.get(simulationId) ?? new Set<string>();
    if (stalled) {
      printers.add(printerId);
      this.#stalledPrinters.set(simulationId, printers);
    } else {
      printers.delete(printerId);
      if (printers.size === 0) this.#stalledPrinters.delete(simulationId);
    }
  }

  isPrinterStalled(simulationId: string, printerId: string): boolean {
    return this.#stalledPrinters.get(simulationId)?.has(printerId) ?? false;
  }

  clearStalledPrinters(simulationId: string): void {
    this.#stalledPrinters.delete(simulationId);
  }

  async getCoordinator(simulationId: string): Promise<QueueCoordinator> {
    const cached = this.#coordinators.get(simulationId);
    if (cached) return cached;
    return this.#lockFor(simulationId).runExclusive(
      `load:${simulationId}`,
      () => this.#loadCoordinator(simulationId),
    );
  }

  async mutate<T>(
    simulationId: string,
    context: MutationContext,
    action: (coordinator: QueueCoordinator, meta: CommandMeta) => Promise<T>,
  ): Promise<MutationResult<T>> {
    return this.#lockFor(simulationId).runExclusive(
      `mutation:${context.correlationId}`,
      async () => {
        const requestHash = hash(context.requestBody);
        if (context.idempotencyKey) {
          let replay;
          try {
            replay = await this.repository.findIdempotency(
              context.actor.id,
              context.routeKey,
              context.idempotencyKey,
            );
          } catch {
            throw new DomainError(
              'PERSISTENCE_UNAVAILABLE',
              'Persistence is unavailable; no state was changed.',
            );
          }
          if (replay) {
            if (replay.requestHash !== requestHash) {
              throw new DomainError(
                'IDEMPOTENCY_CONFLICT',
                'The idempotency key was already used with a different request.',
              );
            }
            const current = await this.#loadCoordinator(simulationId);
            return {
              value: replay.response as T,
              stateVersion: current.snapshot().stateVersion,
              statusCode: replay.statusCode,
              replayed: true,
            };
          }
        }

        const current = await this.#loadCoordinator(simulationId);
        const beforeVersion = current.snapshot().stateVersion;
        const candidate = current.fork();
        const startedAt = performance.now();
        const meta: CommandMeta = {
          commandId: randomUUID(),
          correlationId: context.correlationId,
          ...(context.expectedStateVersion === undefined
            ? {}
            : { expectedStateVersion: context.expectedStateVersion }),
        };
        try {
          const value = await action(candidate, meta);
          const state = candidate.exportState();
          const auditRecord = audit(
            context,
            beforeVersion,
            state.stateVersion,
            'ACCEPTED',
            performance.now() - startedAt,
          );
          const events = enrichAuditEvents(
            candidate.drainEvents(),
            auditRecord,
          );
          const idempotency: IdempotencyRecord | undefined =
            context.idempotencyKey
              ? {
                  actorId: context.actor.id,
                  routeKey: context.routeKey,
                  key: context.idempotencyKey,
                  requestHash,
                  statusCode: context.statusCode,
                  response: value,
                }
              : undefined;
          await this.#commit({
            simulationId,
            expectedStateVersion: beforeVersion,
            state,
            events,
            audit: auditRecord,
            ...(idempotency ? { idempotency } : {}),
          });
          this.#coordinators.set(simulationId, candidate);
          this.#notify({ simulationId, state, events });
          return {
            value,
            stateVersion: state.stateVersion,
            statusCode: context.statusCode,
            replayed: false,
          };
        } catch (error) {
          if (error instanceof DomainError) {
            const auditRecord = audit(
              context,
              beforeVersion,
              beforeVersion,
              'REJECTED',
              performance.now() - startedAt,
              error.code,
            );
            const rejectedEvents = enrichAuditEvents(
              candidate.drainEvents(),
              auditRecord,
            );
            await this.#commit({
              simulationId,
              expectedStateVersion: beforeVersion,
              state: current.exportState(),
              events:
                error.code === 'PERSISTENCE_UNAVAILABLE' ? [] : rejectedEvents,
              audit: auditRecord,
            });
          }
          throw error;
        }
      },
    );
  }

  #newCoordinator(): QueueCoordinator {
    const printers: PrinterState[] = [
      {
        id: randomUUID(),
        name: 'Mono Printer',
        status: 'READY',
        pagesPerMinute: 60,
        supportsColor: false,
        supportsDuplex: true,
        version: 0,
      },
      {
        id: randomUUID(),
        name: 'Color Printer',
        status: 'READY',
        pagesPerMinute: 45,
        supportsColor: true,
        supportsDuplex: true,
        version: 0,
      },
    ];
    return new QueueCoordinator(
      new SimulationClock(),
      {
        algorithm: this.defaults.algorithm,
        agingIntervalMs: this.defaults.agingIntervalMs,
        agingFactor: this.defaults.agingFactor,
        priorityCap: this.defaults.priorityCap,
      },
      printers,
      this.defaults.queueCapacity,
      this.defaults.workerLeaseMs,
    );
  }

  async #loadCoordinator(simulationId: string): Promise<QueueCoordinator> {
    const concurrent = this.#coordinators.get(simulationId);
    if (concurrent) return concurrent;
    let persisted;
    try {
      persisted = await this.repository.load(simulationId);
    } catch {
      throw new DomainError(
        'PERSISTENCE_UNAVAILABLE',
        'Persistence is unavailable; no state was changed.',
      );
    }
    const coordinator = persisted
      ? QueueCoordinator.restore(persisted)
      : this.#newCoordinator();
    if (
      !persisted ||
      coordinator.snapshot().stateVersion !== persisted.stateVersion
    ) {
      const state = coordinator.exportState();
      const events = coordinator.drainEvents();
      await this.#commit({
        simulationId,
        expectedStateVersion: persisted?.stateVersion ?? null,
        state,
        events,
        audit: systemAudit(
          simulationId,
          persisted ? 'RESTORE_SIMULATION' : 'CREATE_SIMULATION',
          persisted?.stateVersion ?? 0,
          state.stateVersion,
        ),
      });
      this.#notify({ simulationId, state, events });
    }
    this.#coordinators.set(simulationId, coordinator);
    return coordinator;
  }

  #lockFor(simulationId: string): FairMutex {
    const existing = this.#locks.get(simulationId);
    if (existing) return existing;
    const created = new FairMutex();
    this.#locks.set(simulationId, created);
    return created;
  }

  async #commit(commit: StateCommit): Promise<void> {
    try {
      await this.repository.commit(commit);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        'PERSISTENCE_UNAVAILABLE',
        'Persistence is unavailable; no state was changed.',
      );
    }
  }

  #notify(notice: CommitNotice): void {
    for (const listener of this.#listeners) {
      try {
        listener(notice);
      } catch {
        // A projection listener cannot roll back an already committed mutation.
      }
    }
  }
}

function audit(
  context: MutationContext,
  before: number,
  after: number,
  outcome: AuditRecord['outcome'],
  durationMs: number,
  reasonCode?: string,
): AuditRecord {
  return {
    id: randomUUID(),
    actorKind: context.actorKind ?? 'USER',
    actorId: context.actor.id,
    commandType: context.commandType,
    correlationId: context.correlationId,
    stateVersionBefore: before,
    stateVersionAfter: after,
    outcome,
    ...(reasonCode ? { reasonCode } : {}),
    redactedParameters: context.redactedParameters ?? {},
    durationMs,
  };
}

function systemAudit(
  correlationId: string,
  commandType: string,
  before: number,
  after: number,
): AuditRecord {
  return {
    id: randomUUID(),
    actorKind: 'SYSTEM',
    actorId: 'api',
    commandType,
    correlationId,
    stateVersionBefore: before,
    stateVersionAfter: after,
    outcome: 'ACCEPTED',
    redactedParameters: {},
    durationMs: 0,
  };
}

function enrichAuditEvents(
  events: readonly DomainEvent[],
  record: AuditRecord,
): readonly DomainEvent[] {
  return events.map((event) =>
    event.type === 'AUDIT_ENTRY_CREATED'
      ? {
          ...event,
          data: {
            ...event.data,
            auditEntryId: record.id,
            actorKind: record.actorKind,
          },
        }
      : event,
  );
}

function hash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
