import { randomUUID } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { pino } from 'pino';
import { io, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, test } from 'vitest';
import { serverEventSchema, type ServerEvent } from '@printer/contracts';
import { AutomationDaemon } from '../src/agents/index.js';
import { SimulationService } from '../src/application/index.js';
import { QueueCoordinator, SimulationClock } from '../src/domain/index.js';
import { createApp } from '../src/http/app.js';
import { stateResource } from '../src/http/resources.js';
import { PrismaSimulationRepository } from '../src/persistence/index.js';
import { SocketGateway } from '../src/realtime/index.js';

const migration = readFileSync(
  new URL(
    '../prisma/migrations/20260919100029_init/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const simulationId = '10000000-0000-4000-8000-000000000005';
const actorId = '20000000-0000-4000-8000-000000000005';
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('Week 5 live operation', () => {
  test('automation persists dispatch, page progress, completion, and metrics', async () => {
    const { service } = await harness();
    const daemon = new AutomationDaemon(service, 1_000, 5_000);
    await submit(service, simulationId, 2);
    await daemon.tickSimulation(simulationId);
    expect(
      (await service.getCoordinator(simulationId)).snapshot().jobs[0]?.status,
    ).toBe('PRINTING');
    await daemon.tickSimulation(simulationId);
    expect(
      (await service.getCoordinator(simulationId)).snapshot().jobs[0],
    ).toMatchObject({ status: 'PRINTING', pagesCompleted: 1 });
    await daemon.tickSimulation(simulationId);
    expect(
      (await service.getCoordinator(simulationId)).snapshot().jobs[0],
    ).toMatchObject({ status: 'COMPLETED', pagesCompleted: 2 });
    daemon.stop();

    const persisted = await service.repository.load(simulationId);
    expect(persisted?.jobs[0]?.status).toBe('COMPLETED');
    expect(
      (await service.repository.readEventsAfter(simulationId, 0, 0, 100))
        .length,
    ).toBeGreaterThan(0);
  });

  test('authenticated Socket.IO clients receive snapshots, durable events, and replay', async () => {
    const { service, repository } = await harness();
    const app = createApp(pino({ enabled: false }), '0.1.0', false, {
      service,
    });
    const server = createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const port = (server.address() as AddressInfo).port;
    const gateway = new SocketGateway(
      server,
      service,
      repository,
      'http://localhost:3000',
    );
    cleanups.push(async () => {
      await gateway.close();
      if (server.listening)
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const socket = io(`http://127.0.0.1:${port}/simulations`, {
      auth: { userId: actorId, role: 'OPERATOR' },
      transports: ['websocket'],
    });
    await connected(socket);
    const initial = nextEvent(socket);
    const initialAck = await subscribe(socket);
    expect(initialAck.data.mode).toBe('LIVE');
    expect((await initial).type).toBe('system.snapshot');

    const pauseAck = await socketAck(socket, 'simulation.pause.request', {
      simulationId,
      commandId: randomUUID(),
      expectedStateVersion: 0,
    });
    expect(pauseAck, JSON.stringify(pauseAck)).toMatchObject({ ok: true });
    expect(
      (await service.getCoordinator(simulationId)).clock.state.paused,
    ).toBe(true);
    const resumeAck = await socketAck(socket, 'simulation.resume.request', {
      simulationId,
      commandId: randomUUID(),
      expectedStateVersion: 1,
      speedMultiplier: 2,
    });
    expect(resumeAck.ok).toBe(true);
    expect(
      (await service.getCoordinator(simulationId)).clock.state.speedMultiplier,
    ).toBe(2);

    const created = nextEvent(socket, 'job.created');
    await submit(service, simulationId, 1);
    await gateway.dispatchOnce();
    expect((await created).type).toBe('job.created');
    socket.disconnect();

    const replaySocket = io(`http://127.0.0.1:${port}/simulations`, {
      auth: { userId: actorId, role: 'VIEWER' },
      transports: ['websocket'],
    });
    await connected(replaySocket);
    const replayed = nextEvent(replaySocket, 'job.created');
    const replayAck = await subscribe(replaySocket, {
      stateVersion: 0,
      eventIndex: 0,
    });
    expect(replayAck.data.mode).toBe('REPLAY');
    expect((await replayed).type).toBe('job.created');
    replaySocket.disconnect();
  });

  test('paper-jam recovery preserves pages and fencing rejects stalled work', async () => {
    const coordinator = domainCoordinator(1_000);
    await coordinator.submitJob({ commandId: randomUUID() }, submission(3));
    const assignment = await coordinator.dispatch(
      { commandId: randomUUID() },
      '40000000-0000-4000-8000-000000000005',
    );
    coordinator.clock.advanceSimulationBy(1_000);
    await coordinator.advancePage(
      { commandId: randomUUID() },
      assignment!.printerId,
      assignment!.lease.leaseId,
      assignment!.lease.fenceToken,
    );
    await coordinator.jamPrinter(
      { commandId: randomUUID() },
      assignment!.printerId,
    );
    expect(coordinator.snapshot().jobs[0]).toMatchObject({
      status: 'PAUSED',
      pagesCompleted: 1,
    });
    await coordinator.recoverPrinter(
      { commandId: randomUUID() },
      assignment!.printerId,
      true,
    );
    expect(coordinator.snapshot().jobs[0]).toMatchObject({
      status: 'PRINTING',
      pagesCompleted: 1,
    });

    await coordinator.reportWorkerStall(
      { commandId: randomUUID() },
      assignment!.printerId,
    );
    coordinator.clock.advanceSimulationBy(1_001);
    await coordinator.recoverStalledJob(
      { commandId: randomUUID() },
      assignment!.printerId,
    );
    expect(coordinator.snapshot().jobs[0]).toMatchObject({
      status: 'READY',
      pagesCompleted: 1,
      retryCount: 1,
    });
    await expect(
      coordinator.advancePage(
        { commandId: randomUUID() },
        assignment!.printerId,
        assignment!.lease.leaseId,
        assignment!.lease.fenceToken,
      ),
    ).rejects.toMatchObject({ code: 'LOCK_NOT_OWNED' });
  });

  test('load balancing picks the fastest compatible printer and starvation warnings clear on dispatch', async () => {
    const coordinator = new QueueCoordinator(
      new SimulationClock(),
      {
        algorithm: 'FCFS',
        agingIntervalMs: 5_000,
        agingFactor: 2,
        priorityCap: 100,
      },
      [
        {
          id: '40000000-0000-4000-8000-000000000006',
          name: 'Slow Printer',
          status: 'READY',
          pagesPerMinute: 30,
          supportsColor: true,
          supportsDuplex: true,
          version: 0,
        },
        {
          id: '40000000-0000-4000-8000-000000000007',
          name: 'Fast Printer',
          status: 'READY',
          pagesPerMinute: 120,
          supportsColor: true,
          supportsDuplex: true,
          version: 0,
        },
      ],
    );
    await coordinator.submitJob({ commandId: randomUUID() }, submission(4));
    coordinator.clock.advanceSimulationBy(30_000);
    expect(stateResource(simulationId, coordinator).alerts).toHaveLength(1);
    const assignment = await coordinator.dispatch({ commandId: randomUUID() });
    expect(assignment?.printerId).toBe('40000000-0000-4000-8000-000000000007');
    expect(stateResource(simulationId, coordinator).alerts).toHaveLength(0);
  });
});

async function harness() {
  const directory = mkdtempSync(join(tmpdir(), 'printer-week5-'));
  const path = join(directory, 'test.db');
  const database = new Database(path);
  database.exec(migration);
  database.close();
  const repository = new PrismaSimulationRepository(`file:${path}`);
  const service = new SimulationService(repository, {
    queueCapacity: 100,
    algorithm: 'FCFS',
    agingIntervalMs: 5_000,
    agingFactor: 2,
    priorityCap: 100,
    workerLeaseMs: 5_000,
  });
  await service.initialize();
  cleanups.push(async () => {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { service, repository };
}

async function submit(
  service: SimulationService,
  targetSimulationId: string,
  pages: number,
) {
  return service.mutate(
    targetSimulationId,
    {
      actor: { id: actorId, role: 'OPERATOR' },
      correlationId: randomUUID(),
      commandType: 'CREATE_JOB',
      routeKey: 'test:create-job',
      requestBody: { pages },
      statusCode: 202,
    },
    (coordinator, meta) =>
      coordinator.submitJob(meta, {
        ...submission(pages),
        id: randomUUID(),
      }),
  );
}

function submission(pages: number) {
  return {
    id: '30000000-0000-4000-8000-000000000005',
    ownerId: actorId,
    input: {
      documentName: 'Week 5 live job',
      pages,
      basePriority: 50,
      colorMode: 'MONO' as const,
      duplex: false,
      arrivalDelayMs: 0,
    },
  };
}

function domainCoordinator(workerLeaseMs: number) {
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
        id: '40000000-0000-4000-8000-000000000005',
        name: 'Recovery Printer',
        status: 'READY',
        pagesPerMinute: 60,
        supportsColor: true,
        supportsDuplex: true,
        version: 0,
      },
    ],
    10,
    workerLeaseMs,
  );
}

function connected(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
}

function subscribe(
  socket: Socket,
  lastSeen?: { stateVersion: number; eventIndex: number },
): Promise<{ ok: true; data: { mode: string } }> {
  return new Promise((resolve) => {
    socket.emit(
      'simulation.subscribe',
      { simulationId, ...(lastSeen ? { lastSeen } : {}) },
      resolve,
    );
  });
}

function nextEvent(socket: Socket, type?: ServerEvent['type']) {
  return new Promise<ServerEvent>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for ${type ?? 'event'}.`)),
      2_000,
    );
    socket.on('simulation.event', (input: unknown) => {
      const event = serverEventSchema.parse(input);
      if (type && event.type !== type) return;
      clearTimeout(timeout);
      resolve(event);
    });
  });
}

function socketAck(
  socket: Socket,
  event: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean }> {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}
