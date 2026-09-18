import { z } from 'zod';
import {
  durationSchema,
  errorCodeSchema,
  nonNegativeIntSchema,
  pagesSchema,
  speedMultiplierSchema,
  timestampSchema,
  uuidSchema,
} from './primitives.js';
import {
  agentStatusSchema,
  alertSchema,
  jobResourceSchema,
  metricsResourceSchema,
  printerResourceSchema,
  schedulerConfigSchema,
  simulationResourceSchema,
  stateSnapshotSchema,
} from './resources.js';
import {
  pauseSimulationRequestSchema,
  resumeSimulationRequestSchema,
} from './requests.js';

export const socketEnvelopeSchema = <T extends string, D extends z.ZodType>(
  type: T,
  data: D,
) =>
  z.object({
    protocolVersion: z.literal(1),
    eventId: uuidSchema,
    type: z.literal(type),
    occurredAt: timestampSchema,
    simulationId: uuidSchema,
    correlationId: uuidSchema,
    stateVersion: nonNegativeIntSchema,
    eventIndex: nonNegativeIntSchema,
    simulationTimeMs: durationSchema,
    data,
  });

const jobData = z.object({ job: jobResourceSchema });
const printerData = z.object({ printer: printerResourceSchema });
const resourceId = z.string().min(1);
export const serverEventSchema = z.discriminatedUnion('type', [
  socketEnvelopeSchema('system.snapshot', stateSnapshotSchema),
  socketEnvelopeSchema(
    'system.resync.required',
    z.object({
      expectedNextVersion: nonNegativeIntSchema,
      currentStateVersion: nonNegativeIntSchema,
      snapshotUrl: z.string().min(1),
    }),
  ),
  socketEnvelopeSchema('simulation.updated', simulationResourceSchema),
  socketEnvelopeSchema('job.created', jobData),
  socketEnvelopeSchema(
    'job.updated',
    jobData.extend({ changedFields: z.array(z.string()) }),
  ),
  socketEnvelopeSchema(
    'job.progressed',
    z
      .object({
        jobId: uuidSchema,
        printerId: uuidSchema,
        pagesCompleted: nonNegativeIntSchema,
        pages: pagesSchema,
        percent: z.number().min(0).max(100),
        leaseFenceToken: nonNegativeIntSchema.optional(),
      })
      .refine(
        (progress) => progress.pagesCompleted <= progress.pages,
        'Completed pages cannot exceed total pages.',
      ),
  ),
  socketEnvelopeSchema(
    'job.completed',
    jobData.extend({
      waitMs: durationSchema,
      serviceMs: durationSchema,
      turnaroundMs: durationSchema,
    }),
  ),
  socketEnvelopeSchema(
    'job.cancelled',
    jobData.extend({ stoppedAfterPage: nonNegativeIntSchema.optional() }),
  ),
  socketEnvelopeSchema(
    'job.failed',
    jobData.extend({ code: z.string().min(1), retryExhausted: z.boolean() }),
  ),
  socketEnvelopeSchema(
    'queue.reordered',
    z.object({
      orderedJobIds: z.array(uuidSchema),
      reasons: z.record(uuidSchema, z.string()),
      schedulerRevision: nonNegativeIntSchema,
    }),
  ),
  socketEnvelopeSchema(
    'queue.capacity.updated',
    z
      .object({
        used: nonNegativeIntSchema,
        capacity: z.number().int().min(1).max(100_000),
      })
      .refine(
        (queue) => queue.used <= queue.capacity,
        'Queue use cannot exceed capacity.',
      ),
  ),
  socketEnvelopeSchema('printer.created', printerData),
  socketEnvelopeSchema(
    'printer.updated',
    printerData.extend({ changedFields: z.array(z.string()) }),
  ),
  socketEnvelopeSchema(
    'printer.jammed',
    printerData.extend({
      affectedJobId: uuidSchema.optional(),
      autoRecoverAt: timestampSchema.optional(),
    }),
  ),
  socketEnvelopeSchema(
    'printer.recovered',
    printerData.extend({ resumedJobId: uuidSchema.optional() }),
  ),
  socketEnvelopeSchema(
    'mutex.acquired',
    z.object({
      resourceId,
      ownerWorkerId: uuidSchema,
      acquiredAt: timestampSchema,
      expiresAt: timestampSchema,
      fenceToken: nonNegativeIntSchema,
      waiters: nonNegativeIntSchema,
    }),
  ),
  socketEnvelopeSchema(
    'mutex.released',
    z.object({
      resourceId,
      releasedAt: timestampSchema,
      heldForMs: durationSchema,
      fenceToken: nonNegativeIntSchema,
    }),
  ),
  socketEnvelopeSchema(
    'mutex.force_released',
    z.object({
      resourceId,
      fencedLeaseId: uuidSchema,
      newFenceToken: nonNegativeIntSchema,
      recoveredJobId: uuidSchema.optional(),
    }),
  ),
  socketEnvelopeSchema(
    'scheduler.config.updated',
    z.object({
      config: schedulerConfigSchema,
      appliedToQueuedJobs: z.boolean(),
    }),
  ),
  socketEnvelopeSchema('metrics.updated', metricsResourceSchema),
  socketEnvelopeSchema(
    'agent.status.updated',
    agentStatusSchema.extend({ reason: z.string().optional() }),
  ),
  socketEnvelopeSchema('alert.raised', z.object({ alert: alertSchema })),
  socketEnvelopeSchema(
    'alert.cleared',
    z.object({ alertId: uuidSchema, clearedAt: timestampSchema }),
  ),
  socketEnvelopeSchema(
    'benchmark.completed',
    z.object({
      benchmarkId: uuidSchema,
      workloadHash: z.string().min(1),
      summaryUrl: z.string().min(1),
    }),
  ),
  socketEnvelopeSchema(
    'audit.entry.created',
    z.object({
      auditEntryId: uuidSchema,
      commandType: z.string().min(1),
      actorKind: z.enum(['USER', 'AGENT', 'SYSTEM']),
      outcome: z.enum(['ACCEPTED', 'REJECTED', 'FAILED']),
    }),
  ),
]);

const simulationScope = { simulationId: uuidSchema };
const commandScope = {
  ...simulationScope,
  commandId: uuidSchema,
  expectedStateVersion: nonNegativeIntSchema,
};
export const subscribeRequestSchema = z.strictObject({
  ...simulationScope,
  lastSeen: z
    .strictObject({
      stateVersion: nonNegativeIntSchema,
      eventIndex: nonNegativeIntSchema,
    })
    .optional(),
});
export const subscribeAckSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('LIVE'),
    currentStateVersion: nonNegativeIntSchema,
  }),
  z.object({
    mode: z.literal('REPLAY'),
    fromStateVersion: nonNegativeIntSchema,
    currentStateVersion: nonNegativeIntSchema,
  }),
  z.object({
    mode: z.literal('RESYNC_REQUIRED'),
    snapshotUrl: z.string().min(1),
    currentStateVersion: nonNegativeIntSchema,
  }),
]);
export const clientEventPayloadSchemas = {
  'simulation.subscribe': subscribeRequestSchema,
  'simulation.unsubscribe': z.strictObject(simulationScope),
  'simulation.pause.request': pauseSimulationRequestSchema.extend(commandScope),
  'simulation.resume.request':
    resumeSimulationRequestSchema.extend(commandScope),
  'simulation.speed.request': z.strictObject({
    ...commandScope,
    speedMultiplier: speedMultiplierSchema,
  }),
  'telemetry.preference.set': z.strictObject({
    ...simulationScope,
    progressHz: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(4),
      z.literal(10),
    ]),
  }),
  'client.ping': z.strictObject({ sentAt: timestampSchema }),
} as const;
export const socketAckSchema = <T extends z.ZodType>(data: T) =>
  z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data }),
    z.object({
      ok: z.literal(false),
      error: z.object({
        code: errorCodeSchema,
        message: z.string(),
        retryable: z.boolean(),
      }),
    }),
  ]);
export const pingAckSchema = z.object({
  sentAt: timestampSchema,
  serverAt: timestampSchema,
});
export type ServerEvent = z.infer<typeof serverEventSchema>;
export type ServerEventType = ServerEvent['type'];
export type SubscribeAck = z.infer<typeof subscribeAckSchema>;
export type ClientEventPayloads = {
  [K in keyof typeof clientEventPayloadSchemas]: z.infer<
    (typeof clientEventPayloadSchemas)[K]
  >;
};
