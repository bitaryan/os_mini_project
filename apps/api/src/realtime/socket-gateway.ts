import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import {
  clientEventPayloadSchemas,
  roleSchema,
  serverEventSchema,
  subscribeRequestSchema,
  uuidSchema,
  type ServerEvent,
  type StateSnapshot,
  type SubscribeAck,
} from '@printer/contracts';
import type { SimulationService } from '../application/index.js';
import { DomainError, QueueCoordinator } from '../domain/index.js';
import { jobResources, stateResource } from '../http/resources.js';
import type {
  PersistedEvent,
  SimulationRepository,
} from '../persistence/index.js';

const eventName = 'simulation.event';

export class SocketGateway {
  readonly io: Server;
  readonly #namespace;
  #timer: ReturnType<typeof setInterval> | undefined;
  #dispatching = false;

  constructor(
    server: HttpServer,
    readonly service: SimulationService,
    readonly repository: SimulationRepository,
    webOrigin: string,
    readonly agentStatuses: () => StateSnapshot['agents'] = () => [],
  ) {
    this.io = new Server(server, {
      cors: { origin: webOrigin, methods: ['GET', 'POST'] },
    });
    this.#namespace = this.io.of('/simulations');
    this.#namespace.use((socket, next) => {
      const userId = uuidSchema.safeParse(socket.handshake.auth['userId']);
      const role = roleSchema.safeParse(socket.handshake.auth['role']);
      if (!userId.success || !role.success) {
        next(new Error('UNAUTHENTICATED'));
        return;
      }
      socket.data['actor'] = { id: userId.data, role: role.data };
      next();
    });
    this.#namespace.on('connection', (socket) => {
      socket.on('simulation.subscribe', async (input, acknowledge) => {
        const parsed = subscribeRequestSchema.safeParse(input);
        if (!parsed.success) {
          acknowledge({
            ok: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: 'The subscription request is invalid.',
              retryable: false,
            },
          });
          return;
        }
        const { simulationId, lastSeen } = parsed.data;
        const coordinator = await this.service.getCoordinator(simulationId);
        const currentVersion = coordinator.snapshot().stateVersion;
        await socket.join(room(simulationId));
        if (!lastSeen) {
          socket.emit(
            eventName,
            snapshotEvent(
              simulationId,
              coordinator,
              currentVersion,
              0,
              this.agentStatuses(),
            ),
          );
          acknowledge({
            ok: true,
            data: { mode: 'LIVE', currentStateVersion: currentVersion },
          });
          return;
        }
        const replay = await this.repository.readEventsAfter(
          simulationId,
          lastSeen.stateVersion,
          lastSeen.eventIndex,
          501,
        );
        if (
          replay.length > 500 ||
          (replay.length === 0 && lastSeen.stateVersion < currentVersion)
        ) {
          acknowledge({
            ok: true,
            data: {
              mode: 'RESYNC_REQUIRED',
              snapshotUrl: `/api/v1/simulations/${simulationId}/state`,
              currentStateVersion: currentVersion,
            },
          });
          return;
        }
        for (const record of replay) {
          socket.emit(eventName, await this.#toEvent(record));
        }
        const data: SubscribeAck =
          replay.length > 0
            ? {
                mode: 'REPLAY',
                fromStateVersion: replay[0]?.stateVersion ?? currentVersion,
                currentStateVersion: currentVersion,
              }
            : { mode: 'LIVE', currentStateVersion: currentVersion };
        acknowledge({ ok: true, data });
      });
      socket.on('simulation.unsubscribe', async (input, acknowledge) => {
        const parsed = subscribeRequestSchema
          .pick({ simulationId: true })
          .safeParse(input);
        if (!parsed.success) {
          acknowledge?.(
            socketFailure('VALIDATION_ERROR', 'Invalid unsubscribe request.'),
          );
          return;
        }
        await socket.leave(room(parsed.data.simulationId));
        acknowledge?.({
          ok: true,
          data: { simulationId: parsed.data.simulationId },
        });
      });
      socket.on('simulation.pause.request', async (input, acknowledge) => {
        const parsed =
          clientEventPayloadSchemas['simulation.pause.request'].safeParse(
            input,
          );
        if (!parsed.success) {
          acknowledge(
            socketFailure('VALIDATION_ERROR', 'Invalid pause request.'),
          );
          return;
        }
        const actor = socket.data['actor'] as {
          id: string;
          role: 'VIEWER' | 'OPERATOR' | 'ADMIN';
        };
        if (actor.role === 'VIEWER') {
          acknowledge(socketFailure('FORBIDDEN', 'Operator role is required.'));
          return;
        }
        try {
          const result = await this.service.mutate(
            parsed.data.simulationId,
            {
              actor,
              correlationId: parsed.data.commandId,
              commandType: 'PAUSE_SIMULATION',
              routeKey: 'socket:simulation.pause.request',
              requestBody: parsed.data,
              expectedStateVersion: parsed.data.expectedStateVersion,
              idempotencyKey: parsed.data.commandId,
              statusCode: 200,
            },
            async (coordinator, meta) => coordinator.pause(meta),
          );
          acknowledge({
            ok: true,
            data: { stateVersion: result.stateVersion },
          });
        } catch (error) {
          acknowledge(socketError(error));
        }
      });
      socket.on('simulation.resume.request', async (input, acknowledge) => {
        const parsed =
          clientEventPayloadSchemas['simulation.resume.request'].safeParse(
            input,
          );
        if (!parsed.success) {
          acknowledge(
            socketFailure('VALIDATION_ERROR', 'Invalid resume request.'),
          );
          return;
        }
        const actor = socket.data['actor'] as {
          id: string;
          role: 'VIEWER' | 'OPERATOR' | 'ADMIN';
        };
        if (actor.role === 'VIEWER') {
          acknowledge(socketFailure('FORBIDDEN', 'Operator role is required.'));
          return;
        }
        try {
          const result = await this.service.mutate(
            parsed.data.simulationId,
            {
              actor,
              correlationId: parsed.data.commandId,
              commandType: 'RESUME_SIMULATION',
              routeKey: 'socket:simulation.resume.request',
              requestBody: parsed.data,
              expectedStateVersion: parsed.data.expectedStateVersion,
              idempotencyKey: parsed.data.commandId,
              statusCode: 200,
            },
            async (coordinator, meta) =>
              coordinator.resume(meta, parsed.data.speedMultiplier),
          );
          acknowledge({
            ok: true,
            data: { stateVersion: result.stateVersion },
          });
        } catch (error) {
          acknowledge(socketError(error));
        }
      });
      socket.on('simulation.speed.request', async (input, acknowledge) => {
        const parsed =
          clientEventPayloadSchemas['simulation.speed.request'].safeParse(
            input,
          );
        if (!parsed.success) {
          acknowledge(
            socketFailure('VALIDATION_ERROR', 'Invalid speed request.'),
          );
          return;
        }
        const actor = socket.data['actor'] as {
          id: string;
          role: 'VIEWER' | 'OPERATOR' | 'ADMIN';
        };
        if (actor.role === 'VIEWER') {
          acknowledge(socketFailure('FORBIDDEN', 'Operator role is required.'));
          return;
        }
        try {
          const result = await this.service.mutate(
            parsed.data.simulationId,
            {
              actor,
              correlationId: parsed.data.commandId,
              commandType: 'UPDATE_SIMULATION_SPEED',
              routeKey: 'socket:simulation.speed.request',
              requestBody: parsed.data,
              expectedStateVersion: parsed.data.expectedStateVersion,
              idempotencyKey: parsed.data.commandId,
              statusCode: 200,
            },
            async (coordinator, meta) =>
              coordinator.updateSimulation(meta, {
                speedMultiplier: parsed.data.speedMultiplier,
              }),
          );
          acknowledge({
            ok: true,
            data: { stateVersion: result.stateVersion },
          });
        } catch (error) {
          acknowledge(socketError(error));
        }
      });
      socket.on('telemetry.preference.set', (input, acknowledge) => {
        const parsed =
          clientEventPayloadSchemas['telemetry.preference.set'].safeParse(
            input,
          );
        if (!parsed.success) {
          acknowledge(
            socketFailure('VALIDATION_ERROR', 'Invalid telemetry preference.'),
          );
          return;
        }
        socket.data['progressHz'] = Math.min(parsed.data.progressHz, 10);
        acknowledge({
          ok: true,
          data: { progressHz: socket.data['progressHz'] as number },
        });
      });
      socket.on('client.ping', (input, acknowledge) => {
        const parsed =
          clientEventPayloadSchemas['client.ping'].safeParse(input);
        if (!parsed.success) {
          acknowledge(
            socketFailure('VALIDATION_ERROR', 'Invalid ping request.'),
          );
          return;
        }
        acknowledge({
          sentAt: parsed.data.sentAt,
          serverAt: new Date().toISOString(),
        });
      });
    });
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.dispatchOnce(), 100);
    this.#timer.unref();
    void this.dispatchOnce();
  }

  async close(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.io.close();
  }

  async dispatchOnce(): Promise<void> {
    if (this.#dispatching) return;
    this.#dispatching = true;
    try {
      const records = await this.repository.readUndelivered(250);
      const delivered: string[] = [];
      for (const record of coalesceProgress(records)) {
        this.#namespace
          .to(room(record.simulationId))
          .emit(eventName, await this.#toEvent(record));
      }
      for (const record of records) {
        if (record.outboxId) delivered.push(record.outboxId);
      }
      await this.repository.markDelivered(delivered);
    } finally {
      this.#dispatching = false;
    }
  }

  async #toEvent(record: PersistedEvent): Promise<ServerEvent> {
    const state =
      (await this.repository.loadVersion(
        record.simulationId,
        record.stateVersion,
      )) ?? (await this.repository.load(record.simulationId));
    if (!state) throw new Error('Event state snapshot is unavailable.');
    const coordinator = QueueCoordinator.fromState(state);
    const snapshot = {
      ...stateResource(record.simulationId, coordinator),
      agents: this.agentStatuses(),
    };
    const envelope = {
      protocolVersion: 1 as const,
      eventId: record.eventId,
      occurredAt: record.occurredAt,
      simulationId: record.simulationId,
      correlationId: record.correlationId ?? record.eventId,
      stateVersion: state.stateVersion,
      eventIndex: record.eventIndex,
      simulationTimeMs: record.simulationTimeMs,
    };
    const data = record.payload.data;
    const jobId = typeof data['jobId'] === 'string' ? data['jobId'] : undefined;
    const printerId =
      typeof data['printerId'] === 'string' ? data['printerId'] : undefined;
    const job = jobId
      ? jobResources(record.simulationId, coordinator).find(
          (candidate) => candidate.id === jobId,
        )
      : undefined;
    const printer = printerId
      ? snapshot.printers.find((candidate) => candidate.id === printerId)
      : undefined;

    let event: unknown;
    if (record.type === 'JOB_SUBMITTED' && job) {
      event = { ...envelope, type: 'job.created', data: { job } };
    } else if (record.type === 'JOB_PROGRESS_UPDATED' && job && printerId) {
      event = {
        ...envelope,
        type: 'job.progressed',
        data: {
          jobId: job.id,
          printerId,
          pagesCompleted: job.pagesCompleted,
          pages: job.pages,
          percent: (job.pagesCompleted / job.pages) * 100,
        },
      };
    } else if (record.type === 'JOB_COMPLETED' && job) {
      const queued = Date.parse(job.queuedAt);
      const started = Date.parse(job.startedAt as string);
      const completed = Date.parse(job.completedAt as string);
      event = {
        ...envelope,
        type: 'job.completed',
        data: {
          job,
          waitMs: started - queued,
          serviceMs: completed - started,
          turnaroundMs: completed - queued,
        },
      };
    } else if (record.type === 'JOB_CANCELLED' && job) {
      event = {
        ...envelope,
        type: 'job.cancelled',
        data: {
          job,
          ...(typeof data['stoppedAfterPage'] === 'number'
            ? { stoppedAfterPage: data['stoppedAfterPage'] }
            : {}),
        },
      };
    } else if (
      [
        'JOB_UPDATED',
        'JOB_DISPATCHED',
        'JOB_CANCELLATION_REQUESTED',
        'JOB_RECOVERED',
      ].includes(record.type) &&
      job
    ) {
      event = {
        ...envelope,
        type: 'job.updated',
        data: { job, changedFields: Object.keys(data) },
      };
    } else if (record.type === 'PRINTER_CREATED' && printer) {
      event = { ...envelope, type: 'printer.created', data: { printer } };
    } else if (record.type === 'PRINTER_UPDATED' && printer) {
      event = {
        ...envelope,
        type: 'printer.updated',
        data: { printer, changedFields: Object.keys(data) },
      };
    } else if (record.type === 'PRINTER_JAMMED' && printer) {
      event = {
        ...envelope,
        type: 'printer.jammed',
        data: { printer, ...(jobId ? { affectedJobId: jobId } : {}) },
      };
    } else if (record.type === 'PRINTER_RECOVERED' && printer) {
      event = {
        ...envelope,
        type: 'printer.recovered',
        data: { printer, ...(jobId ? { resumedJobId: jobId } : {}) },
      };
    } else if (record.type === 'JOB_FAILED' && job) {
      event = {
        ...envelope,
        type: 'job.failed',
        data: {
          job,
          code: 'WATCHDOG_RETRY_EXHAUSTED',
          retryExhausted: true,
        },
      };
    } else if (
      record.type === 'MUTEX_FORCE_RELEASED' &&
      printerId &&
      typeof data['fencedLeaseId'] === 'string' &&
      typeof data['newFenceToken'] === 'number'
    ) {
      event = {
        ...envelope,
        type: 'mutex.force_released',
        data: {
          resourceId: `printer:${printerId}`,
          fencedLeaseId: data['fencedLeaseId'],
          newFenceToken: data['newFenceToken'],
          ...(jobId ? { recoveredJobId: jobId } : {}),
        },
      };
    } else if (
      record.type === 'MUTEX_ACQUIRED' &&
      printerId &&
      typeof data['ownerWorkerId'] === 'string' &&
      typeof data['acquiredAtMs'] === 'number' &&
      typeof data['expiresAtMs'] === 'number' &&
      typeof data['fenceToken'] === 'number' &&
      typeof data['waiters'] === 'number'
    ) {
      event = {
        ...envelope,
        type: 'mutex.acquired',
        data: {
          resourceId: `printer:${printerId}`,
          ownerWorkerId: data['ownerWorkerId'],
          acquiredAt: simulationIso(data['acquiredAtMs']),
          expiresAt: simulationIso(data['expiresAtMs']),
          fenceToken: data['fenceToken'],
          waiters: data['waiters'],
        },
      };
    } else if (
      record.type === 'MUTEX_RELEASED' &&
      printerId &&
      typeof data['releasedAtMs'] === 'number' &&
      typeof data['heldForMs'] === 'number' &&
      typeof data['fenceToken'] === 'number'
    ) {
      event = {
        ...envelope,
        type: 'mutex.released',
        data: {
          resourceId: `printer:${printerId}`,
          releasedAt: simulationIso(data['releasedAtMs']),
          heldForMs: data['heldForMs'],
          fenceToken: data['fenceToken'],
        },
      };
    } else if (
      record.type === 'SIMULATION_PAUSED' ||
      record.type === 'SIMULATION_RESUMED' ||
      record.type === 'SIMULATION_UPDATED' ||
      record.type === 'SIMULATION_RESET'
    ) {
      event = {
        ...envelope,
        type: 'simulation.updated',
        data: snapshot.simulation,
      };
    } else if (
      record.type === 'QUEUE_REORDERED' &&
      Array.isArray(data['orderedJobIds'])
    ) {
      event = {
        ...envelope,
        type: 'queue.reordered',
        data: {
          orderedJobIds: data['orderedJobIds'],
          reasons: Object.fromEntries(
            snapshot.jobs
              .filter((job) => job.schedulerExplanation)
              .map((job) => [job.id, job.schedulerExplanation as string]),
          ),
          schedulerRevision: snapshot.simulation.scheduler.revision,
        },
      };
    } else if (
      record.type === 'QUEUE_CAPACITY_UPDATED' &&
      typeof data['used'] === 'number' &&
      typeof data['capacity'] === 'number'
    ) {
      event = {
        ...envelope,
        type: 'queue.capacity.updated',
        data: { used: data['used'], capacity: data['capacity'] },
      };
    } else if (record.type === 'SCHEDULER_CONFIG_UPDATED') {
      event = {
        ...envelope,
        type: 'scheduler.config.updated',
        data: {
          config: snapshot.simulation.scheduler,
          appliedToQueuedJobs: true,
        },
      };
    } else if (
      record.type === 'AUDIT_ENTRY_CREATED' &&
      typeof data['auditEntryId'] === 'string' &&
      typeof data['commandType'] === 'string' &&
      typeof data['actorKind'] === 'string' &&
      typeof data['outcome'] === 'string'
    ) {
      event = {
        ...envelope,
        type: 'audit.entry.created',
        data: {
          auditEntryId: data['auditEntryId'],
          commandType: data['commandType'],
          actorKind: data['actorKind'],
          outcome: data['outcome'],
        },
      };
    } else if (
      record.type === 'BENCHMARK_COMPLETED' &&
      typeof data['benchmarkId'] === 'string' &&
      typeof data['workloadHash'] === 'string' &&
      typeof data['summaryUrl'] === 'string'
    ) {
      event = {
        ...envelope,
        type: 'benchmark.completed',
        data: {
          benchmarkId: data['benchmarkId'],
          workloadHash: data['workloadHash'],
          summaryUrl: data['summaryUrl'],
        },
      };
    } else {
      event = { ...envelope, type: 'system.snapshot', data: snapshot };
    }
    return serverEventSchema.parse(event);
  }
}

function room(simulationId: string): string {
  return `simulation:${simulationId}`;
}

function simulationIso(timeMs: number): string {
  return new Date(Date.UTC(2026, 0, 1) + timeMs).toISOString();
}

function snapshotEvent(
  simulationId: string,
  coordinator: QueueCoordinator,
  stateVersion: number,
  eventIndex: number,
  agents: StateSnapshot['agents'],
): ServerEvent {
  return serverEventSchema.parse({
    protocolVersion: 1,
    eventId: randomUUID(),
    type: 'system.snapshot',
    occurredAt: new Date().toISOString(),
    simulationId,
    correlationId: randomUUID(),
    stateVersion,
    eventIndex,
    simulationTimeMs: coordinator.clock.state.simulationTimeMs,
    data: { ...stateResource(simulationId, coordinator), agents },
  });
}

function coalesceProgress(
  records: readonly PersistedEvent[],
): readonly PersistedEvent[] {
  const lastProgress = new Map<string, PersistedEvent>();
  const retained: PersistedEvent[] = [];
  for (const record of records) {
    if (record.type !== 'JOB_PROGRESS_UPDATED') {
      retained.push(record);
      continue;
    }
    const jobId = record.payload.data['jobId'];
    lastProgress.set(`${record.simulationId}:${String(jobId)}`, record);
  }
  return [...retained, ...lastProgress.values()].sort(
    (left, right) =>
      left.stateVersion - right.stateVersion ||
      left.eventIndex - right.eventIndex,
  );
}

function socketFailure(
  code: 'VALIDATION_ERROR' | 'FORBIDDEN',
  message: string,
) {
  return { ok: false, error: { code, message, retryable: false } } as const;
}

function socketError(error: unknown) {
  if (error instanceof DomainError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        retryable: error.code === 'STATE_VERSION_CONFLICT',
      },
    } as const;
  }
  return {
    ok: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'The command could not be completed.',
      retryable: false,
    },
  } as const;
}
