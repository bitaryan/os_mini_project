import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { pino } from 'pino';
import request from 'supertest';
import { afterEach, describe, expect, test } from 'vitest';
import {
  auditEntrySchema,
  benchmarkResultSchema,
  jobDetailSchema,
  stateSnapshotSchema,
  timelineResourceSchema,
} from '@printer/contracts';
import { SimulationService } from '../src/application/index.js';
import {
  QueueCoordinator,
  SimulationClock,
  type CoordinatorState,
} from '../src/domain/index.js';
import { createApp } from '../src/http/app.js';
import {
  PrismaSimulationRepository,
  type PersistedIdempotencyResult,
  type SimulationRepository,
  type StateCommit,
} from '../src/persistence/index.js';

const logger = pino({ enabled: false });
const simulationId = '10000000-0000-4000-8000-000000000001';
const actorId = '20000000-0000-4000-8000-000000000001';
const operator = { 'X-User-Id': actorId, 'X-User-Role': 'OPERATOR' };
const viewer = { 'X-User-Id': actorId, 'X-User-Role': 'VIEWER' };
const admin = { 'X-User-Id': actorId, 'X-User-Role': 'ADMIN' };
const basePath = `/api/v1/simulations/${simulationId}`;
const job = {
  documentName: 'week-4.pdf',
  pages: 4,
  basePriority: 50,
  colorMode: 'MONO' as const,
  duplex: false,
  arrivalDelayMs: 0,
};
const migration = readFileSync(
  new URL(
    '../prisma/migrations/20260919100029_init/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('persistent REST API', () => {
  test('serves ready state and rejects unauthenticated, unauthorized, and invalid requests', async () => {
    const harness = await createHarness();
    const ready = await request(harness.app).get('/health/ready').expect(200);
    expect(ready.body.status).toBe('ready');
    const preflight = await request(harness.app)
      .options(`${basePath}/jobs`)
      .set('Origin', 'http://localhost:3000')
      .expect(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(
      'http://localhost:3000',
    );

    const state = await request(harness.app)
      .get(`${basePath}/state`)
      .set(operator)
      .expect(200);
    expect(stateSnapshotSchema.parse(state.body.data).printers).toHaveLength(2);

    expect(
      (await request(harness.app).get(`${basePath}/state`).expect(401)).body
        .error.code,
    ).toBe('UNAUTHENTICATED');
    expect(
      (
        await request(harness.app)
          .post(`${basePath}/actions/pause`)
          .set(viewer)
          .send({})
          .expect(403)
      ).body.error.code,
    ).toBe('FORBIDDEN');
    expect(
      (
        await request(harness.app)
          .post(`${basePath}/jobs`)
          .set(operator)
          .set('Idempotency-Key', 'invalid-body')
          .send({ ...job, unexpected: true })
          .expect(400)
      ).body.error.code,
    ).toBe('VALIDATION_ERROR');
    expect(
      (
        await request(harness.app)
          .post(`${basePath}/jobs`)
          .set(operator)
          .send(job)
          .expect(400)
      ).body.error.code,
    ).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(
      (
        await request(harness.app)
          .post(`${basePath}/actions/pause`)
          .set(operator)
          .set('Idempotency-Key', 'pause')
          .send({})
          .expect(400)
      ).body.error.code,
    ).toBe('VALIDATION_ERROR');
    expect(
      (
        await request(harness.app)
          .post(`${basePath}/jobs`)
          .set(operator)
          .set('Content-Type', 'text/plain')
          .send('not json')
          .expect(415)
      ).body.error.code,
    ).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  test('commits state, events, audit, outbox, and idempotency atomically', async () => {
    const harness = await createHarness(1);
    const first = await request(harness.app)
      .post(`${basePath}/jobs`)
      .set(operator)
      .set('Idempotency-Key', 'job-1')
      .send(job)
      .expect(202);
    const replay = await request(harness.app)
      .post(`${basePath}/jobs`)
      .set(operator)
      .set('Idempotency-Key', 'job-1')
      .send(job)
      .expect(202);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.body.data.id).toBe(first.body.data.id);

    expect(
      (
        await request(harness.app)
          .post(`${basePath}/jobs`)
          .set(operator)
          .set('Idempotency-Key', 'job-1')
          .send({ ...job, pages: 5 })
          .expect(409)
      ).body.error.code,
    ).toBe('IDEMPOTENCY_CONFLICT');
    expect(
      (
        await request(harness.app)
          .post(`${basePath}/jobs`)
          .set(operator)
          .set('Idempotency-Key', 'stale')
          .set('If-Match', '"0"')
          .send({ ...job, documentName: 'stale.pdf' })
          .expect(409)
      ).body.error.code,
    ).toBe('STATE_VERSION_CONFLICT');
    expect(
      (
        await request(harness.app)
          .post(`${basePath}/jobs`)
          .set(operator)
          .set('Idempotency-Key', 'full')
          .send({ ...job, documentName: 'full.pdf' })
          .expect(409)
      ).body.error.code,
    ).toBe('QUEUE_CAPACITY_EXCEEDED');

    const database = new Database(harness.databasePath, { readonly: true });
    expect(rowCount(database, 'Job')).toBe(1);
    expect(rowCount(database, 'IdempotencyKey')).toBe(1);
    expect(rowCount(database, 'AuditEntry')).toBeGreaterThanOrEqual(4);
    expect(rowCount(database, 'DomainEvent')).toBe(
      rowCount(database, 'OutboxEntry'),
    );
    database.close();
  });

  test('supports job, printer, scheduler, pagination, and terminal-history routes', async () => {
    const harness = await createHarness(5);
    const created = [];
    for (let index = 0; index < 3; index += 1) {
      const response = await request(harness.app)
        .post(`${basePath}/jobs`)
        .set(operator)
        .set('Idempotency-Key', `job-${index}`)
        .send({ ...job, documentName: `job-${index}.pdf` })
        .expect(202);
      created.push(response.body.data);
    }

    const updated = await request(harness.app)
      .patch(`${basePath}/jobs/${created[0].id}`)
      .set(operator)
      .set('Idempotency-Key', 'priority')
      .send({ basePriority: 90, expectedJobVersion: 0 })
      .expect(200);
    expect(updated.body.data.basePriority).toBe(90);
    const cancelled = await request(harness.app)
      .delete(`${basePath}/jobs/${created[1].id}`)
      .set(operator)
      .set('Idempotency-Key', 'cancel')
      .expect(200);
    expect(cancelled.body.data.status).toBe('CANCELLED');

    const pageOne = await request(harness.app)
      .get(`${basePath}/jobs?limit=1`)
      .set(viewer)
      .expect(200);
    expect(pageOne.body.data.items).toHaveLength(1);
    expect(pageOne.body.data.hasMore).toBe(true);
    await request(harness.app)
      .get(`${basePath}/jobs?limit=1&cursor=${pageOne.body.data.nextCursor}`)
      .set(viewer)
      .expect(200);

    const printer = await request(harness.app)
      .post(`${basePath}/printers`)
      .set(admin)
      .set('Idempotency-Key', 'printer')
      .send({
        name: 'Lab Printer',
        pagesPerMinute: 30,
        supportsColor: true,
        supportsDuplex: false,
      })
      .expect(201);
    const scheduler = await request(harness.app)
      .put(`${basePath}/scheduler`)
      .set(operator)
      .set('Idempotency-Key', 'scheduler')
      .set('If-Match', `"${printer.body.meta.stateVersion}"`)
      .send({ algorithm: 'SJF', applyToQueuedJobs: true })
      .expect(200);
    expect(scheduler.body.data.algorithm).toBe('SJF');

    const detail = await request(harness.app)
      .get(`${basePath}/jobs/${created[0].id}`)
      .set(viewer)
      .expect(200);
    expect(
      jobDetailSchema.parse(detail.body.data).timeline.length,
    ).toBeGreaterThan(0);

    const updatedPrinter = await request(harness.app)
      .patch(`${basePath}/printers/${printer.body.data.id}`)
      .set(admin)
      .set('Idempotency-Key', 'printer-update')
      .set('If-Match', `"${scheduler.body.meta.stateVersion}"`)
      .send({
        name: 'Updated Lab Printer',
        online: false,
        expectedPrinterVersion: printer.body.data.version,
      })
      .expect(200);
    expect(updatedPrinter.body.data.status).toBe('OFFLINE');

    const simulation = await request(harness.app)
      .patch(basePath)
      .set(admin)
      .set('Idempotency-Key', 'simulation-update')
      .set('If-Match', `"${updatedPrinter.body.meta.stateVersion}"`)
      .send({ queueCapacity: 20, speedMultiplier: 2 })
      .expect(200);
    expect(simulation.body.data.queueCapacity).toBe(20);
    expect(simulation.body.data.speedMultiplier).toBe(2);

    await request(harness.app).get(`${basePath}/audit`).set(viewer).expect(403);
    const audit = await request(harness.app)
      .get(`${basePath}/audit?commandType=UPDATE_PRINTER&limit=10`)
      .set(admin)
      .expect(200);
    expect(audit.body.data.items).toHaveLength(1);
    auditEntrySchema.parse(audit.body.data.items[0]);

    const reset = await request(harness.app)
      .post(`${basePath}/actions/reset`)
      .set(admin)
      .set('Idempotency-Key', 'reset')
      .set('If-Match', `"${simulation.body.meta.stateVersion}"`)
      .send({ confirmSimulationId: simulationId, preserveHistory: true })
      .expect(202);
    expect(reset.body.data.simulation.status).toBe('PAUSED');
    const resetState = await request(harness.app)
      .get(`${basePath}/state`)
      .set(viewer)
      .expect(200);
    expect(resetState.body.data.jobs).toHaveLength(1);
    expect(resetState.body.data.jobs[0].status).toBe('CANCELLED');
    expect(resetState.body.data.metrics.completedJobs).toBe(0);
  });

  test('runs isolated deterministic benchmarks and serves timeline exports', async () => {
    const harness = await createHarness(10);
    const before = await request(harness.app)
      .get(`${basePath}/state`)
      .set(operator)
      .expect(200);
    const benchmarkRequest = {
      source: {
        kind: 'EXPLICIT',
        jobs: [
          {
            id: '30000000-0000-4000-8000-000000000001',
            arrivalTimeMs: 0,
            pages: 8,
            priority: 10,
            colorMode: 'MONO',
            duplex: false,
          },
          {
            id: '30000000-0000-4000-8000-000000000002',
            arrivalTimeMs: 0,
            pages: 1,
            priority: 90,
            colorMode: 'MONO',
            duplex: false,
          },
        ],
      },
      algorithms: ['FCFS', 'SJF', 'PRIORITY_AGING'],
      printerModel: {
        count: 1,
        pagesPerMinute: 60,
        supportsColor: true,
        supportsDuplex: true,
      },
      seed: 42,
    };
    const accepted = await request(harness.app)
      .post(`${basePath}/benchmarks`)
      .set(operator)
      .set('Idempotency-Key', 'benchmark-42')
      .send(benchmarkRequest)
      .expect(202);
    const result = await request(harness.app)
      .get(`${basePath}/benchmarks/${accepted.body.data.benchmarkId}`)
      .set(viewer)
      .expect(200);
    expect(
      benchmarkResultSchema.parse(result.body.data).evaluations,
    ).toHaveLength(3);
    expect(result.body.data.evaluations[1].metrics.averageWaitMs).toBeLessThan(
      result.body.data.evaluations[0].metrics.averageWaitMs,
    );
    const csv = await request(harness.app)
      .get(
        `${basePath}/benchmarks/${accepted.body.data.benchmarkId}/export?format=csv`,
      )
      .set(viewer)
      .expect('Content-Type', /text\/csv/)
      .expect(200);
    expect(csv.text.split('\n')[0]).toBe(
      'algorithm,averageWaitMs,medianWaitMs,p95WaitMs,maximumWaitMs,averageTurnaroundMs,makespanMs,throughputJobsPerMinute,printerUtilization,fairnessIndex,starvationCount',
    );
    const timeline = await request(harness.app)
      .get(`${basePath}/analytics/timeline?fromMs=0`)
      .set(viewer)
      .expect(200);
    timelineResourceSchema.parse(timeline.body.data);
    const after = await request(harness.app)
      .get(`${basePath}/state`)
      .set(operator)
      .expect(200);
    expect(after.body.meta.stateVersion).toBe(before.body.meta.stateVersion);
  });

  test('preserves terminal history and safely requeues active work after restart', async () => {
    const harness = await createHarness(5);
    const submitted = await request(harness.app)
      .post(`${basePath}/jobs`)
      .set(operator)
      .set('Idempotency-Key', 'terminal')
      .send(job)
      .expect(202);
    await request(harness.app)
      .delete(`${basePath}/jobs/${submitted.body.data.id}`)
      .set(operator)
      .set('Idempotency-Key', 'terminal-cancel')
      .expect(200);
    await harness.service.close();

    const restartedRepository = new PrismaSimulationRepository(
      `file:${harness.databasePath}`,
    );
    const restarted = new SimulationService(restartedRepository, defaults(5));
    await restarted.initialize();
    const restored = await restarted.getCoordinator(simulationId);
    expect(restored.snapshot().jobs[0]?.status).toBe('CANCELLED');
    await restarted.close();

    const activeSimulationId = '10000000-0000-4000-8000-000000000002';
    const activeRepository = new PrismaSimulationRepository(
      `file:${harness.databasePath}`,
    );
    await activeRepository.connect();
    const active = activeCoordinator();
    await active.submitJob(
      { commandId: 'submit-active' },
      {
        id: '30000000-0000-4000-8000-000000000001',
        ownerId: actorId,
        input: job,
      },
    );
    await active.dispatch(
      { commandId: 'dispatch-active' },
      '40000000-0000-4000-8000-000000000001',
    );
    await activeRepository.commit(
      commitFor(activeSimulationId, active.exportState()),
    );
    await activeRepository.disconnect();

    const recoveryRepository = new PrismaSimulationRepository(
      `file:${harness.databasePath}`,
    );
    const recovery = new SimulationService(recoveryRepository, defaults(5));
    await recovery.initialize();
    const recovered = await recovery.getCoordinator(activeSimulationId);
    expect(recovered.clock.state.paused).toBe(true);
    expect(recovered.snapshot().jobs[0]?.status).toBe('READY');
    expect(recovered.snapshot().jobs[0]?.assignedPrinterId).toBeUndefined();
    expect(recovered.snapshot().printers[0]?.mutex.locked).toBe(false);
    await recovery.close();
  });

  test('does not advance in-memory state when persistence fails', async () => {
    const database = createDatabase();
    const real = new PrismaSimulationRepository(database.url);
    const failing = new FailNextCommitRepository(real);
    const service = new SimulationService(failing, defaults(5));
    await service.initialize();
    const app = createApp(logger, '0.1.0', false, { service });
    await request(app).get(`${basePath}/state`).set(operator).expect(200);
    failing.failNextCommit = true;
    expect(
      (
        await request(app)
          .post(`${basePath}/jobs`)
          .set(operator)
          .set('Idempotency-Key', 'db-failure')
          .send(job)
          .expect(503)
      ).body.error.code,
    ).toBe('PERSISTENCE_UNAVAILABLE');
    const state = await request(app)
      .get(`${basePath}/state`)
      .set(operator)
      .expect(200);
    expect(state.body.data.jobs).toHaveLength(0);
    expect(state.body.meta.stateVersion).toBe(0);
    await service.close();
    rmSync(database.directory, { recursive: true, force: true });
  });
});

async function createHarness(queueCapacity = 10) {
  const database = createDatabase();
  const repository = new PrismaSimulationRepository(database.url);
  const service = new SimulationService(repository, defaults(queueCapacity));
  await service.initialize();
  let closed = false;
  cleanups.push(async () => {
    if (!closed) await service.close();
    rmSync(database.directory, { recursive: true, force: true });
  });
  return {
    app: createApp(logger, '0.1.0', false, {
      service,
      webOrigin: 'http://localhost:3000',
    }),
    service: {
      ...service,
      close: async () => {
        await service.close();
        closed = true;
      },
    },
    databasePath: database.path,
  };
}

function createDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'printer-week4-'));
  const path = join(directory, 'test.db');
  const database = new Database(path);
  database.pragma('foreign_keys = ON');
  database.exec(migration);
  database.close();
  return { directory, path, url: `file:${path}` };
}

function defaults(queueCapacity: number) {
  return {
    queueCapacity,
    algorithm: 'FCFS' as const,
    agingIntervalMs: 5_000,
    agingFactor: 2,
    priorityCap: 100,
    workerLeaseMs: 5_000,
  };
}

function rowCount(database: Database.Database, table: string): number {
  return (
    database.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as {
      count: number;
    }
  ).count;
}

function activeCoordinator() {
  return new QueueCoordinator(
    new SimulationClock(),
    {
      algorithm: 'FCFS',
      agingIntervalMs: 5_000,
      agingFactor: 2,
      priorityCap: 100,
    },
    [
      {
        id: '40000000-0000-4000-8000-000000000001',
        name: 'Recovery Printer',
        status: 'READY',
        pagesPerMinute: 60,
        supportsColor: true,
        supportsDuplex: true,
        version: 0,
      },
    ],
    5,
  );
}

function commitFor(simulation: string, state: CoordinatorState): StateCommit {
  return {
    simulationId: simulation,
    expectedStateVersion: null,
    state,
    events: [],
    audit: {
      actorKind: 'SYSTEM',
      actorId: 'test',
      commandType: 'TEST_SNAPSHOT',
      correlationId: simulation,
      stateVersionBefore: 0,
      stateVersionAfter: state.stateVersion,
      outcome: 'ACCEPTED',
      redactedParameters: {},
      durationMs: 0,
    },
  };
}

class FailNextCommitRepository implements SimulationRepository {
  failNextCommit = false;

  constructor(readonly delegate: SimulationRepository) {}

  connect() {
    return this.delegate.connect();
  }

  disconnect() {
    return this.delegate.disconnect();
  }

  isReady() {
    return this.delegate.isReady();
  }

  load(simulation: string): Promise<CoordinatorState | null> {
    return this.delegate.load(simulation);
  }

  loadVersion(
    simulation: string,
    stateVersion: number,
  ): Promise<CoordinatorState | null> {
    return this.delegate.loadVersion(simulation, stateVersion);
  }

  findIdempotency(
    actor: string,
    route: string,
    key: string,
  ): Promise<PersistedIdempotencyResult | null> {
    return this.delegate.findIdempotency(actor, route, key);
  }

  commit(value: StateCommit): Promise<void> {
    if (this.failNextCommit) {
      this.failNextCommit = false;
      return Promise.reject(new Error('simulated database failure'));
    }
    return this.delegate.commit(value);
  }

  readUndelivered(limit: number) {
    return this.delegate.readUndelivered(limit);
  }

  readEventsAfter(
    simulation: string,
    stateVersion: number,
    eventIndex: number,
    limit: number,
  ) {
    return this.delegate.readEventsAfter(
      simulation,
      stateVersion,
      eventIndex,
      limit,
    );
  }

  readEventsThrough(simulation: string, toMs: number, limit: number) {
    return this.delegate.readEventsThrough(simulation, toMs, limit);
  }

  saveBenchmark(record: Parameters<SimulationRepository['saveBenchmark']>[0]) {
    return this.delegate.saveBenchmark(record);
  }

  readBenchmark(simulation: string, benchmarkId: string) {
    return this.delegate.readBenchmark(simulation, benchmarkId);
  }

  readAudit(
    simulation: string,
    query: Parameters<SimulationRepository['readAudit']>[1],
    offset: number,
    limit: number,
  ) {
    return this.delegate.readAudit(simulation, query, offset, limit);
  }

  markDelivered(outboxIds: readonly string[]) {
    return this.delegate.markDelivered(outboxIds);
  }
}
