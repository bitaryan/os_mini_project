import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  agentCommandSchema,
  apiErrorResponseSchema,
  benchmarkRequestSchema,
  clientEventPayloadSchemas,
  createBurstRequestSchema,
  createJobRequestSchema,
  errorCodeSchema,
  healthReadySchema,
  jobResourceSchema,
  serverEventSchema,
  socketAckSchema,
  subscribeAckSchema,
  updateSchedulerRequestSchema,
} from '../src/index.js';

const id = '00000000-0000-4000-8000-000000000001';
const time = '2026-09-21T00:00:00.000Z';
const input = {
  documentName: '  Lecture notes  ',
  pages: 10,
  colorMode: 'MONO',
  duplex: false,
};
const job = {
  ...input,
  documentName: 'Lecture notes',
  id,
  simulationId: id,
  ownerId: id,
  pagesCompleted: 0,
  pagesRemaining: 10,
  basePriority: 50,
  effectivePriority: 50,
  status: 'READY',
  submittedAt: time,
  queuedAt: time,
  retryCount: 0,
  sequence: 0,
  version: 0,
};
const envelope = {
  protocolVersion: 1,
  eventId: id,
  occurredAt: time,
  simulationId: id,
  correlationId: id,
  stateVersion: 0,
  eventIndex: 0,
  simulationTimeMs: 0,
};

describe('v1 request boundaries', () => {
  test('normalizes names and supplies only documented defaults', () => {
    expect(createJobRequestSchema.parse(input)).toEqual({
      ...input,
      documentName: 'Lecture notes',
      basePriority: 50,
      arrivalDelayMs: 0,
    });
  });
  test.each([0, 10_001, 1.5, '10', NaN, Infinity, null])(
    'rejects invalid pages: %s',
    (pages) => {
      expect(
        createJobRequestSchema.safeParse({ ...input, pages }).success,
      ).toBe(false);
    },
  );
  test.each([
    { documentName: ' ' },
    { documentName: 'x'.repeat(121) },
    { basePriority: -1 },
    { basePriority: 101 },
    { basePriority: 0.5 },
    { arrivalDelayMs: -1 },
    { arrivalDelayMs: 3_600_001 },
    { colorMode: 'RGB' },
    { duplex: 'false' },
    { effectivePriority: 100 },
    { ownerId: id },
  ])('rejects invalid or server-owned fields: %j', (patch) => {
    expect(
      createJobRequestSchema.safeParse({ ...input, ...patch }).success,
    ).toBe(false);
  });
  test('accepts inclusive job limits', () => {
    expect(
      createJobRequestSchema.safeParse({
        ...input,
        pages: 10_000,
        basePriority: 100,
        arrivalDelayMs: 3_600_000,
      }).success,
    ).toBe(true);
    expect(
      createJobRequestSchema.safeParse({ ...input, pages: 1, basePriority: 0 })
        .success,
    ).toBe(true);
  });
  test('validates nested scheduler settings strictly', () => {
    const request = {
      algorithm: 'PRIORITY_AGING',
      applyToQueuedJobs: true,
      aging: {
        agingIntervalMs: 5_000,
        agingFactor: 2,
        priorityCap: 100,
        starvationWarningMs: 30_000,
      },
    };
    expect(updateSchedulerRequestSchema.safeParse(request).success).toBe(true);
    expect(
      updateSchedulerRequestSchema.safeParse({
        ...request,
        aging: { ...request.aging, agingFactor: 0 },
      }).success,
    ).toBe(false);
    expect(
      updateSchedulerRequestSchema.safeParse({
        ...request,
        aging: { ...request.aging, revision: 1 },
      }).success,
    ).toBe(false);
  });
  test('checks burst counts, seeds, distribution ranges, and nested fields', () => {
    const burst = {
      mode: 'ATOMIC',
      seed: 42,
      count: 1_000,
      arrival: { kind: 'SIMULTANEOUS' },
      pages: { kind: 'UNIFORM', min: 1, max: 10 },
      priority: { kind: 'FIXED', value: 50 },
      colorRatio: 0,
      duplexRatio: 1,
    };
    expect(createBurstRequestSchema.parse(burst).namePrefix).toBe(
      'Generated Job',
    );
    for (const patch of [
      { count: 1_001 },
      { seed: -1 },
      { seed: 4_294_967_296 },
      { colorRatio: 1.1 },
      { pages: { kind: 'UNIFORM', min: 10, max: 1 } },
      { priority: { kind: 'FIXED', value: 101 } },
      {
        pages: { kind: 'BOUNDED_NORMAL', min: 1, max: 10, mean: 11, stdDev: 2 },
      },
      { arrival: { kind: 'SIMULTANEOUS', intervalMs: 10 } },
    ]) {
      expect(
        createBurstRequestSchema.safeParse({ ...burst, ...patch }).success,
      ).toBe(false);
    }
  });
  test('bounds benchmark work and rejects duplicate IDs and algorithms', () => {
    const benchmarkJob = {
      id,
      arrivalTimeMs: 0,
      pages: 10,
      priority: 50,
      colorMode: 'MONO',
      duplex: false,
    };
    const request = {
      source: { kind: 'EXPLICIT', jobs: [benchmarkJob] },
      algorithms: ['FCFS'],
      printerModel: {
        count: 1,
        pagesPerMinute: 60,
        supportsColor: false,
        supportsDuplex: false,
      },
      seed: 42,
    };
    expect(benchmarkRequestSchema.safeParse(request).success).toBe(true);
    expect(
      benchmarkRequestSchema.safeParse({
        ...request,
        algorithms: ['FCFS', 'FCFS'],
      }).success,
    ).toBe(false);
    expect(
      benchmarkRequestSchema.safeParse({
        ...request,
        source: { kind: 'EXPLICIT', jobs: [benchmarkJob, benchmarkJob] },
      }).success,
    ).toBe(false);
    expect(
      benchmarkRequestSchema.safeParse({
        ...request,
        source: {
          kind: 'EXPLICIT',
          jobs: Array.from({ length: 10_001 }, () => benchmarkJob),
        },
      }).success,
    ).toBe(false);
  });
});

describe('resources and transport', () => {
  test('rejects inconsistent page counts and accepts additive response fields', () => {
    expect(jobResourceSchema.parse({ ...job, futureField: true })).toEqual(job);
    expect(
      jobResourceSchema.safeParse({ ...job, pagesCompleted: 11 }).success,
    ).toBe(false);
    expect(
      jobResourceSchema.safeParse({
        ...job,
        submittedAt: '2026-02-30T00:00:00Z',
      }).success,
    ).toBe(false);
  });
  test('ties each event to its own payload and protocol version', () => {
    expect(
      serverEventSchema.safeParse({
        ...envelope,
        type: 'job.created',
        data: { job },
      }).success,
    ).toBe(true);
    expect(
      serverEventSchema.safeParse({
        ...envelope,
        protocolVersion: 2,
        type: 'job.created',
        data: { job },
      }).success,
    ).toBe(false);
    expect(
      serverEventSchema.safeParse({
        ...envelope,
        type: 'printer.created',
        data: { job },
      }).success,
    ).toBe(false);
    expect(
      serverEventSchema.safeParse({
        ...envelope,
        eventIndex: -1,
        type: 'job.created',
        data: { job },
      }).success,
    ).toBe(false);
  });
  test('checks replay tuples, socket commands, and exclusive acknowledgements', () => {
    expect(
      clientEventPayloadSchemas['simulation.subscribe'].safeParse({
        simulationId: id,
        lastSeen: { stateVersion: 3, eventIndex: 2 },
      }).success,
    ).toBe(true);
    expect(
      clientEventPayloadSchemas['simulation.subscribe'].safeParse({
        simulationId: id,
        lastSeen: { stateVersion: 3 },
      }).success,
    ).toBe(false);
    expect(
      clientEventPayloadSchemas['simulation.speed.request'].safeParse({
        simulationId: id,
        commandId: id,
        expectedStateVersion: 0,
        speedMultiplier: 3,
      }).success,
    ).toBe(false);
    expect(
      socketAckSchema(subscribeAckSchema).safeParse({
        ok: true,
        data: { mode: 'LIVE', currentStateVersion: 3 },
      }).success,
    ).toBe(true);
    expect(
      socketAckSchema(subscribeAckSchema).safeParse({ ok: false }).success,
    ).toBe(false);
  });
  test('restricts watchdog commands to the watchdog and preserves completed pages', () => {
    const command = {
      commandId: id,
      agent: 'watchdog-intercept',
      type: 'RECOVER_INTERRUPTED_JOB',
      issuedAt: time,
      expectedStateVersion: 0,
      correlationId: id,
      payload: { jobId: id, action: 'REQUEUE', preservePagesCompleted: true },
    };
    expect(agentCommandSchema.safeParse(command).success).toBe(true);
    expect(
      agentCommandSchema.safeParse({ ...command, agent: 'load-balancer' })
        .success,
    ).toBe(false);
    expect(
      agentCommandSchema.safeParse({
        ...command,
        payload: { ...command.payload, preservePagesCompleted: false },
      }).success,
    ).toBe(false);
  });
  test('cannot report ready while a required component is missing', () => {
    const health = {
      status: 'not_ready',
      version: '0.1.0',
      components: {
        configuration: 'ready',
        scheduler: 'ready',
        database: 'not_implemented',
        migrations: 'not_implemented',
        coordinator: 'not_implemented',
        invariants: 'not_implemented',
      },
    };
    expect(healthReadySchema.safeParse(health).success).toBe(true);
    expect(
      healthReadySchema.safeParse({ ...health, status: 'ready' }).success,
    ).toBe(false);
  });
  test('matches the documented error example and complete event/error catalogs', () => {
    const specification = readFileSync(
      new URL('../../../docs/API_AND_EVENTS.md', import.meta.url),
      'utf8',
    );
    const example = specification.match(/```json\n([\s\S]*?)\n```/)?.[1];
    expect(example).toBeDefined();
    expect(
      apiErrorResponseSchema.safeParse(JSON.parse(example ?? '')).success,
    ).toBe(true);
    const literals = (name: string) =>
      [
        ...(
          specification.match(new RegExp(`type ${name} =([\\s\\S]*?);`))?.[1] ??
          ''
        ).matchAll(/"([^"]+)"/g),
      ]
        .map((match) => match[1])
        .sort();
    expect([...errorCodeSchema.options].sort()).toEqual(literals('ErrorCode'));
    expect(
      serverEventSchema.options.map((schema) => schema.shape.type.value).sort(),
    ).toEqual(literals('ServerEventType'));
  });
});
