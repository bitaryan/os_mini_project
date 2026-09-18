import { z } from 'zod';
import {
  agentNameSchema,
  colorModeSchema,
  durationSchema,
  jobStatusSchema,
  nonNegativeIntSchema,
  pagesSchema,
  printerStatusSchema,
  prioritySchema,
  schedulingAlgorithmSchema,
  speedMultiplierSchema,
  timestampSchema,
  uuidSchema,
} from './primitives.js';

export const agingConfigSchema = z.object({
  agingIntervalMs: z.number().int().min(1_000).max(300_000),
  agingFactor: z.number().int().min(1).max(25),
  priorityCap: z.number().int().min(1).max(100),
  starvationWarningMs: z.number().int().min(5_000).max(3_600_000),
});

export const schedulerConfigSchema = agingConfigSchema.extend({
  algorithm: schedulingAlgorithmSchema,
  revision: nonNegativeIntSchema,
});

export const jobResourceSchema = z
  .object({
    id: uuidSchema,
    simulationId: uuidSchema,
    ownerId: uuidSchema,
    documentName: z.string().trim().min(1).max(120),
    pages: pagesSchema,
    pagesCompleted: nonNegativeIntSchema,
    pagesRemaining: nonNegativeIntSchema,
    basePriority: prioritySchema,
    effectivePriority: prioritySchema,
    colorMode: colorModeSchema,
    duplex: z.boolean(),
    status: jobStatusSchema,
    blockReason: z.literal('NO_COMPATIBLE_PRINTER').optional(),
    submittedAt: timestampSchema,
    queuedAt: timestampSchema,
    startedAt: timestampSchema.optional(),
    completedAt: timestampSchema.optional(),
    assignedPrinterId: uuidSchema.optional(),
    cancellationRequestedAt: timestampSchema.optional(),
    lastProgressAt: timestampSchema.optional(),
    retryCount: nonNegativeIntSchema,
    rank: z.number().int().positive().optional(),
    sequence: nonNegativeIntSchema,
    version: nonNegativeIntSchema,
    schedulerExplanation: z.string().optional(),
  })
  .refine((job) => job.pagesCompleted + job.pagesRemaining === job.pages, {
    message: 'Completed and remaining pages must equal total pages.',
    path: ['pagesRemaining'],
  });

export const mutexSchema = z.object({
  locked: z.boolean(),
  ownerWorkerId: uuidSchema.optional(),
  leaseId: uuidSchema.optional(),
  acquiredAt: timestampSchema.optional(),
  expiresAt: timestampSchema.optional(),
  fenceToken: nonNegativeIntSchema,
  waiters: nonNegativeIntSchema,
});

export const printerResourceSchema = z.object({
  id: uuidSchema,
  simulationId: uuidSchema,
  name: z.string().trim().min(1).max(80),
  status: printerStatusSchema,
  pagesPerMinute: z.number().min(1).max(600),
  supportsColor: z.boolean(),
  supportsDuplex: z.boolean(),
  activeJobId: uuidSchema.optional(),
  mutex: mutexSchema,
  version: nonNegativeIntSchema,
});

export const simulationResourceSchema = z
  .object({
    id: uuidSchema,
    status: z.enum(['RUNNING', 'PAUSED', 'DEGRADED']),
    simulationTimeMs: durationSchema,
    speedMultiplier: speedMultiplierSchema,
    queueCapacity: z.number().int().min(1).max(100_000),
    queueUsed: nonNegativeIntSchema,
    stateVersion: nonNegativeIntSchema,
    scheduler: schedulerConfigSchema,
  })
  .refine((simulation) => simulation.queueUsed <= simulation.queueCapacity, {
    message: 'Queue use cannot exceed capacity.',
    path: ['queueUsed'],
  });

export const metricsResourceSchema = z.object({
  sampleWindowMs: z.number().int().positive(),
  capturedAt: timestampSchema,
  queuedJobs: nonNegativeIntSchema,
  activeJobs: nonNegativeIntSchema,
  completedJobs: nonNegativeIntSchema,
  failedJobs: nonNegativeIntSchema,
  throughputJobsPerMinute: z.number().nonnegative().nullable(),
  averageWaitMs: z.number().nonnegative().nullable(),
  medianWaitMs: z.number().nonnegative().nullable(),
  p95WaitMs: z.number().nonnegative().nullable(),
  averageTurnaroundMs: z.number().nonnegative().nullable(),
  starvationWarningCount: nonNegativeIntSchema,
  printerUtilization: z.record(uuidSchema, z.number().min(0).max(1)),
});

export const agentStatusSchema = z.object({
  name: agentNameSchema,
  health: z.enum(['HEALTHY', 'DEGRADED', 'STOPPED']),
  circuit: z.enum(['CLOSED', 'OPEN', 'HALF_OPEN']),
  lastActionAt: timestampSchema.optional(),
});

export const alertSchema = z.object({
  id: uuidSchema,
  severity: z.enum(['INFO', 'WARNING', 'CRITICAL']),
  code: z.string().min(1),
  message: z.string().min(1),
  raisedAt: timestampSchema,
  resourceId: z.string().optional(),
});

export const stateSnapshotSchema = z.object({
  simulation: simulationResourceSchema,
  jobs: z.array(jobResourceSchema),
  printers: z.array(printerResourceSchema),
  metrics: metricsResourceSchema,
  agents: z.array(agentStatusSchema),
  alerts: z.array(alertSchema),
});

export const auditEntrySchema = z.object({
  id: uuidSchema,
  occurredAt: timestampSchema,
  simulationId: uuidSchema,
  actor: z.object({
    kind: z.enum(['USER', 'AGENT', 'SYSTEM']),
    id: z.string().min(1),
  }),
  commandType: z.string().min(1),
  correlationId: uuidSchema,
  stateVersionBefore: nonNegativeIntSchema,
  stateVersionAfter: nonNegativeIntSchema,
  outcome: z.enum(['ACCEPTED', 'REJECTED', 'FAILED']),
  reasonCode: z.string().optional(),
  redactedParameters: z.record(z.string(), z.unknown()),
  durationMs: z.number().nonnegative(),
});

export type JobResource = z.infer<typeof jobResourceSchema>;
export type PrinterResource = z.infer<typeof printerResourceSchema>;
export type SchedulerConfig = z.infer<typeof schedulerConfigSchema>;
export type SimulationResource = z.infer<typeof simulationResourceSchema>;
export type MetricsResource = z.infer<typeof metricsResourceSchema>;
export type StateSnapshot = z.infer<typeof stateSnapshotSchema>;
export type AuditEntry = z.infer<typeof auditEntrySchema>;
