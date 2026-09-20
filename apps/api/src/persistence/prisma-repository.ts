import { randomUUID } from 'node:crypto';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '../generated/prisma/client.js';
import type { Prisma } from '../generated/prisma/client.js';
import {
  DomainError,
  type CoordinatorState,
  type DomainEvent,
} from '../domain/index.js';
import type {
  AuditQuery,
  BenchmarkRecord,
  PersistedIdempotencyResult,
  PersistedEvent,
  SimulationRepository,
  StateCommit,
} from './simulation-repository.js';

export class PrismaSimulationRepository implements SimulationRepository {
  readonly #client: PrismaClient;

  constructor(databaseUrl: string) {
    if (!databaseUrl.startsWith('file:')) {
      throw new Error('This repository instance requires a SQLite file URL.');
    }
    this.#client = new PrismaClient({
      adapter: new PrismaBetterSqlite3({ url: databaseUrl }),
    });
  }

  async connect(): Promise<void> {
    await this.#client.$connect();
    await this.#client.$queryRawUnsafe('PRAGMA journal_mode = WAL');
  }

  async disconnect(): Promise<void> {
    await this.#client.$disconnect();
  }

  async isReady(): Promise<boolean> {
    try {
      await Promise.all([
        this.#client.simulation.count(),
        this.#client.schedulerConfig.count(),
        this.#client.job.count(),
        this.#client.printer.count(),
        this.#client.domainEvent.count(),
        this.#client.auditEntry.count(),
        this.#client.idempotencyKey.count(),
        this.#client.snapshot.count(),
        this.#client.benchmarkRun.count(),
        this.#client.outboxEntry.count(),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  async load(simulationId: string): Promise<CoordinatorState | null> {
    const snapshot = await this.#client.snapshot.findFirst({
      where: { simulationId },
      orderBy: [{ stateVersion: 'desc' }, { createdAt: 'desc' }],
    });
    return snapshot ? (snapshot.state as unknown as CoordinatorState) : null;
  }

  async loadVersion(
    simulationId: string,
    stateVersion: number,
  ): Promise<CoordinatorState | null> {
    const snapshot = await this.#client.snapshot.findUnique({
      where: { simulationId_stateVersion: { simulationId, stateVersion } },
    });
    return snapshot ? (snapshot.state as unknown as CoordinatorState) : null;
  }

  async findIdempotency(
    actorId: string,
    routeKey: string,
    key: string,
  ): Promise<PersistedIdempotencyResult | null> {
    const record = await this.#client.idempotencyKey.findUnique({
      where: { actorId_routeKey_key: { actorId, routeKey, key } },
    });
    if (!record || record.expiresAt <= new Date()) return null;
    return {
      requestHash: record.requestHash,
      statusCode: record.statusCode,
      response: record.response,
    };
  }

  async commit(commit: StateCommit): Promise<void> {
    const { state } = commit;
    await this.#client.$transaction(async (database) => {
      const current = await database.simulation.findUnique({
        where: { id: commit.simulationId },
        select: { stateVersion: true },
      });
      if (
        current &&
        commit.expectedStateVersion !== null &&
        current.stateVersion !== commit.expectedStateVersion
      ) {
        throw new DomainError(
          'STATE_VERSION_CONFLICT',
          `Persisted state is version ${current.stateVersion}, expected ${commit.expectedStateVersion}.`,
        );
      }

      await database.simulation.upsert({
        where: { id: commit.simulationId },
        create: {
          id: commit.simulationId,
          status: state.clock.paused ? 'PAUSED' : 'RUNNING',
          simulationTimeMs: state.clock.simulationTimeMs,
          speedMultiplier: state.clock.speedMultiplier,
          queueCapacity: state.queueCapacity,
          stateVersion: state.stateVersion,
        },
        update: {
          status: state.clock.paused ? 'PAUSED' : 'RUNNING',
          simulationTimeMs: state.clock.simulationTimeMs,
          speedMultiplier: state.clock.speedMultiplier,
          queueCapacity: state.queueCapacity,
          stateVersion: state.stateVersion,
        },
      });
      await database.schedulerConfig.upsert({
        where: { simulationId: commit.simulationId },
        create: schedulerData(commit.simulationId, state),
        update: schedulerData(commit.simulationId, state),
      });
      await database.job.deleteMany({
        where: { simulationId: commit.simulationId },
      });
      if (state.jobs.length > 0) {
        await database.job.createMany({
          data: state.jobs.map((job) => ({
            id: job.id,
            simulationId: commit.simulationId,
            ownerId: job.ownerId,
            documentName: job.documentName,
            pages: job.pages,
            pagesCompleted: job.pagesCompleted,
            basePriority: job.basePriority,
            colorMode: job.colorMode,
            duplex: job.duplex,
            status: job.status,
            submittedAtMs: job.submittedAtMs,
            queuedAtMs: job.queuedAtMs,
            startedAtMs: job.startedAtMs ?? null,
            completedAtMs: job.completedAtMs ?? null,
            assignedPrinterId: job.assignedPrinterId ?? null,
            cancellationRequestedAtMs: job.cancellationRequestedAtMs ?? null,
            lastProgressAtMs: job.lastProgressAtMs ?? null,
            retryCount: job.retryCount,
            sequence: job.sequence,
            version: job.version,
          })),
        });
      }
      await database.printer.deleteMany({
        where: { simulationId: commit.simulationId },
      });
      if (state.printers.length > 0) {
        await database.printer.createMany({
          data: state.printers.map((printer) => ({
            id: printer.id,
            simulationId: commit.simulationId,
            name: printer.name,
            status: printer.status,
            pagesPerMinute: printer.pagesPerMinute,
            supportsColor: printer.supportsColor,
            supportsDuplex: printer.supportsDuplex,
            activeJobId: printer.activeJobId ?? null,
            version: printer.version,
          })),
        });
      }
      await database.snapshot.upsert({
        where: {
          simulationId_stateVersion: {
            simulationId: commit.simulationId,
            stateVersion: state.stateVersion,
          },
        },
        create: {
          simulationId: commit.simulationId,
          stateVersion: state.stateVersion,
          state: json(state),
        },
        update: { state: json(state) },
      });

      const eventIndexes = new Map<number, number>();
      for (const event of commit.events) {
        let eventIndex = eventIndexes.get(event.stateVersion);
        if (eventIndex === undefined) {
          eventIndex = await database.domainEvent.count({
            where: {
              simulationId: commit.simulationId,
              stateVersion: event.stateVersion,
            },
          });
        }
        const eventId = randomUUID();
        const payload = json(event);
        await database.domainEvent.create({
          data: {
            id: eventId,
            simulationId: commit.simulationId,
            stateVersion: event.stateVersion,
            eventIndex,
            type: event.type,
            simulationTimeMs: event.simulationTimeMs,
            correlationId: event.correlationId ?? null,
            payload,
          },
        });
        eventIndexes.set(event.stateVersion, eventIndex + 1);
        await database.outboxEntry.create({
          data: {
            simulationId: commit.simulationId,
            eventId,
            payload,
          },
        });
      }
      await database.auditEntry.create({
        data: {
          ...(commit.audit.id ? { id: commit.audit.id } : {}),
          simulationId: commit.simulationId,
          actorKind: commit.audit.actorKind,
          actorId: commit.audit.actorId,
          commandType: commit.audit.commandType,
          correlationId: commit.audit.correlationId,
          stateVersionBefore: commit.audit.stateVersionBefore,
          stateVersionAfter: commit.audit.stateVersionAfter,
          outcome: commit.audit.outcome,
          reasonCode: commit.audit.reasonCode ?? null,
          redactedParameters: json(commit.audit.redactedParameters),
          durationMs: commit.audit.durationMs,
        },
      });
      if (commit.idempotency) {
        await database.idempotencyKey.create({
          data: {
            simulationId: commit.simulationId,
            actorId: commit.idempotency.actorId,
            routeKey: commit.idempotency.routeKey,
            key: commit.idempotency.key,
            requestHash: commit.idempotency.requestHash,
            statusCode: commit.idempotency.statusCode,
            response: json(commit.idempotency.response),
            expiresAt: new Date(Date.now() + 86_400_000),
          },
        });
      }
    });
  }

  async readUndelivered(limit: number): Promise<readonly PersistedEvent[]> {
    const outbox = await this.#client.outboxEntry.findMany({
      where: { deliveredAt: null },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    if (outbox.length === 0) return [];
    const events = await this.#client.domainEvent.findMany({
      where: { id: { in: outbox.map((entry) => entry.eventId) } },
    });
    const byId = new Map(events.map((event) => [event.id, event]));
    return outbox.flatMap((entry) => {
      const event = byId.get(entry.eventId);
      return event ? [persistedEvent(event, entry.id)] : [];
    });
  }

  async readEventsAfter(
    simulationId: string,
    stateVersion: number,
    eventIndex: number,
    limit: number,
  ): Promise<readonly PersistedEvent[]> {
    const events = await this.#client.domainEvent.findMany({
      where: {
        simulationId,
        OR: [
          { stateVersion: { gt: stateVersion } },
          { stateVersion, eventIndex: { gt: eventIndex } },
        ],
      },
      orderBy: [{ stateVersion: 'asc' }, { eventIndex: 'asc' }],
      take: limit,
    });
    return events.map((event) => persistedEvent(event));
  }

  async readEventsThrough(
    simulationId: string,
    toMs: number,
    limit: number,
  ): Promise<readonly PersistedEvent[]> {
    const events = await this.#client.domainEvent.findMany({
      where: { simulationId, simulationTimeMs: { lte: toMs } },
      orderBy: [
        { simulationTimeMs: 'asc' },
        { stateVersion: 'asc' },
        { eventIndex: 'asc' },
      ],
      take: limit,
    });
    return events.map((event) => persistedEvent(event));
  }

  async saveBenchmark(record: BenchmarkRecord): Promise<void> {
    await this.#client.$transaction(async (database) => {
      const prior = await database.benchmarkRun.findUnique({
        where: { id: record.id },
        select: { status: true },
      });
      await database.benchmarkRun.upsert({
        where: { id: record.id },
        create: {
          id: record.id,
          simulationId: record.simulationId,
          workloadHash: record.workloadHash,
          status: record.status,
          request: json(record.request),
          ...(record.result === undefined
            ? {}
            : { result: json(record.result) }),
        },
        update: {
          status: record.status,
          ...(record.result === undefined
            ? {}
            : { result: json(record.result) }),
        },
      });
      if (record.status !== 'COMPLETED' || prior?.status === 'COMPLETED')
        return;
      const simulation = await database.simulation.findUniqueOrThrow({
        where: { id: record.simulationId },
        select: { stateVersion: true, simulationTimeMs: true },
      });
      const eventIndex = await database.domainEvent.count({
        where: {
          simulationId: record.simulationId,
          stateVersion: simulation.stateVersion,
        },
      });
      const eventId = randomUUID();
      const payload = json({
        type: 'BENCHMARK_COMPLETED',
        stateVersion: simulation.stateVersion,
        simulationTimeMs: simulation.simulationTimeMs,
        ...(record.correlationId
          ? { correlationId: record.correlationId }
          : {}),
        data: {
          benchmarkId: record.id,
          workloadHash: record.workloadHash,
          summaryUrl: `/api/v1/simulations/${record.simulationId}/benchmarks/${record.id}`,
        },
      });
      await database.domainEvent.create({
        data: {
          id: eventId,
          simulationId: record.simulationId,
          stateVersion: simulation.stateVersion,
          eventIndex,
          type: 'BENCHMARK_COMPLETED',
          simulationTimeMs: simulation.simulationTimeMs,
          correlationId: record.correlationId ?? null,
          payload,
        },
      });
      await database.outboxEntry.create({
        data: { simulationId: record.simulationId, eventId, payload },
      });
      await database.auditEntry.create({
        data: {
          simulationId: record.simulationId,
          actorKind: 'USER',
          actorId: record.actorId ?? 'unknown',
          commandType: 'RUN_BENCHMARK',
          correlationId: record.correlationId ?? eventId,
          stateVersionBefore: simulation.stateVersion,
          stateVersionAfter: simulation.stateVersion,
          outcome: 'ACCEPTED',
          redactedParameters: json({
            workloadHash: record.workloadHash,
            benchmarkId: record.id,
          }),
          durationMs: 0,
        },
      });
    });
  }

  async readBenchmark(
    simulationId: string,
    benchmarkId: string,
  ): Promise<BenchmarkRecord | null> {
    const record = await this.#client.benchmarkRun.findFirst({
      where: { id: benchmarkId, simulationId },
    });
    return record
      ? {
          id: record.id,
          simulationId: record.simulationId,
          workloadHash: record.workloadHash,
          status: record.status as BenchmarkRecord['status'],
          request: record.request,
          ...(record.result === null ? {} : { result: record.result }),
        }
      : null;
  }

  async readAudit(
    simulationId: string,
    query: AuditQuery,
    offset: number,
    limit: number,
  ) {
    const records = await this.#client.auditEntry.findMany({
      where: {
        simulationId,
        ...(query.from || query.to
          ? {
              occurredAt: {
                ...(query.from ? { gte: new Date(query.from) } : {}),
                ...(query.to ? { lte: new Date(query.to) } : {}),
              },
            }
          : {}),
        ...(query.actorId ? { actorId: query.actorId } : {}),
        ...(query.actorKind ? { actorKind: query.actorKind } : {}),
        ...(query.commandType ? { commandType: query.commandType } : {}),
        ...(query.outcome ? { outcome: query.outcome } : {}),
        ...(query.correlationId ? { correlationId: query.correlationId } : {}),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      skip: offset,
      take: limit + 1,
    });
    return {
      items: records.slice(0, limit).map((record) => ({
        id: record.id,
        occurredAt: record.occurredAt.toISOString(),
        simulationId: record.simulationId,
        actor: {
          kind: record.actorKind as 'USER' | 'AGENT' | 'SYSTEM',
          id: record.actorId,
        },
        commandType: record.commandType,
        correlationId: record.correlationId,
        stateVersionBefore: record.stateVersionBefore,
        stateVersionAfter: record.stateVersionAfter,
        outcome: record.outcome as 'ACCEPTED' | 'REJECTED' | 'FAILED',
        ...(record.reasonCode ? { reasonCode: record.reasonCode } : {}),
        redactedParameters: record.redactedParameters as Record<
          string,
          unknown
        >,
        durationMs: record.durationMs,
      })),
      hasMore: records.length > limit,
    };
  }

  async markDelivered(outboxIds: readonly string[]): Promise<void> {
    if (outboxIds.length === 0) return;
    await this.#client.outboxEntry.updateMany({
      where: { id: { in: [...outboxIds] }, deliveredAt: null },
      data: { deliveredAt: new Date() },
    });
  }
}

function persistedEvent(
  event: {
    id: string;
    simulationId: string;
    stateVersion: number;
    eventIndex: number;
    type: string;
    simulationTimeMs: number;
    correlationId: string | null;
    payload: Prisma.JsonValue;
    createdAt: Date;
  },
  outboxId?: string,
): PersistedEvent {
  return {
    ...(outboxId ? { outboxId } : {}),
    eventId: event.id,
    simulationId: event.simulationId,
    stateVersion: event.stateVersion,
    eventIndex: event.eventIndex,
    type: event.type,
    simulationTimeMs: event.simulationTimeMs,
    ...(event.correlationId ? { correlationId: event.correlationId } : {}),
    occurredAt: event.createdAt.toISOString(),
    payload: event.payload as unknown as DomainEvent,
  };
}

function schedulerData(simulationId: string, state: CoordinatorState) {
  return {
    simulationId,
    algorithm: state.scheduler.algorithm,
    agingIntervalMs: state.scheduler.agingIntervalMs,
    agingFactor: state.scheduler.agingFactor,
    priorityCap: state.scheduler.priorityCap,
    starvationWarningMs: 30_000,
    revision: state.stateVersion,
  };
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}
