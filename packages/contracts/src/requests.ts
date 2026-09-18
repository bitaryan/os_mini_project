import { z } from 'zod';
import {
  colorModeSchema,
  durationSchema,
  nonNegativeIntSchema,
  pagesSchema,
  prioritySchema,
  schedulingAlgorithmSchema,
  speedMultiplierSchema,
  uuidSchema,
} from './primitives.js';
import { agingConfigSchema } from './resources.js';

export const createJobRequestSchema = z.strictObject({
  documentName: z.string().trim().min(1).max(120),
  pages: pagesSchema,
  basePriority: prioritySchema.default(50),
  colorMode: colorModeSchema,
  duplex: z.boolean(),
  arrivalDelayMs: durationSchema.max(3_600_000).default(0),
});
export const submitJobSchema = createJobRequestSchema;
export const updateJobRequestSchema = z.strictObject({
  basePriority: prioritySchema,
  expectedJobVersion: nonNegativeIntSchema,
});
export const pauseSimulationRequestSchema = z.strictObject({
  reason: z.string().max(200).optional(),
});
export const resumeSimulationRequestSchema = z.strictObject({
  speedMultiplier: speedMultiplierSchema.optional(),
});
export const updateSimulationRequestSchema = z
  .strictObject({
    speedMultiplier: speedMultiplierSchema.optional(),
    queueCapacity: z.number().int().min(1).max(100_000).optional(),
  })
  .refine(
    (value) => Object.keys(value).length > 0,
    'At least one update is required.',
  );
export const resetSimulationRequestSchema = z.strictObject({
  confirmSimulationId: uuidSchema,
  preserveHistory: z.boolean(),
});

export const createPrinterRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  pagesPerMinute: z.number().min(1).max(600),
  supportsColor: z.boolean(),
  supportsDuplex: z.boolean(),
  initialStatus: z.enum(['READY', 'OFFLINE']).optional(),
});
export const injectPrinterFaultRequestSchema = z.strictObject({
  fault: z.enum(['PAPER_JAM', 'WORKER_STALL']),
  mode: z.enum(['IMMEDIATE', 'AFTER_CURRENT_PAGE']),
  autoRecoverAfterMs: z.number().int().min(1_000).max(300_000).optional(),
  reason: z.string().max(200).optional(),
});
export const recoverPrinterRequestSchema = z.strictObject({
  resumeInterruptedJob: z.boolean(),
});
export const updateSchedulerRequestSchema = z.strictObject({
  algorithm: schedulingAlgorithmSchema,
  applyToQueuedJobs: z.boolean(),
  aging: agingConfigSchema.strict().optional(),
});
export const rebalanceRequestSchema = z.strictObject({
  dryRun: z.boolean(),
  reason: z.enum([
    'CONFIG_CHANGED',
    'PRINTER_ADDED',
    'PRINTER_REMOVED',
    'OPERATOR_REQUEST',
  ]),
});

export function distributionSchema(minimum: number, maximum: number) {
  const value = z.number().int().min(minimum).max(maximum);
  return z
    .discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('FIXED'), value }),
      z.strictObject({ kind: z.literal('UNIFORM'), min: value, max: value }),
      z.strictObject({
        kind: z.literal('BOUNDED_NORMAL'),
        min: value,
        max: value,
        mean: z.number().min(minimum).max(maximum),
        stdDev: z.number().positive(),
      }),
    ])
    .superRefine((distribution, context) => {
      if (distribution.kind === 'FIXED') return;
      if (distribution.min > distribution.max)
        context.addIssue({
          code: 'custom',
          path: ['max'],
          message: 'Maximum must be at least minimum.',
        });
      if (
        distribution.kind === 'BOUNDED_NORMAL' &&
        (distribution.mean < distribution.min ||
          distribution.mean > distribution.max)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['mean'],
          message: 'Mean must fall within the bounds.',
        });
      }
    });
}

export const createBurstRequestSchema = z.strictObject({
  mode: z.enum(['ATOMIC', 'AVAILABLE_CAPACITY']),
  seed: nonNegativeIntSchema.max(4_294_967_295),
  count: z.number().int().min(1).max(1_000),
  arrival: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('SIMULTANEOUS') }),
    z.strictObject({
      kind: z.literal('UNIFORM_INTERVAL'),
      intervalMs: durationSchema.max(3_600_000),
    }),
    z.strictObject({
      kind: z.literal('POISSON'),
      meanIntervalMs: z.number().int().positive().max(3_600_000),
    }),
  ]),
  pages: distributionSchema(1, 10_000),
  priority: distributionSchema(0, 100),
  colorRatio: z.number().min(0).max(1),
  duplexRatio: z.number().min(0).max(1),
  namePrefix: z.string().trim().min(1).max(100).default('Generated Job'),
});

export const benchmarkJobSchema = z.strictObject({
  id: uuidSchema,
  arrivalTimeMs: durationSchema,
  pages: pagesSchema,
  priority: prioritySchema,
  colorMode: colorModeSchema,
  duplex: z.boolean(),
});
export const benchmarkRequestSchema = z.strictObject({
  source: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('CURRENT_SNAPSHOT') }),
    z.strictObject({
      kind: z.literal('SAVED_WORKLOAD'),
      workloadId: uuidSchema,
    }),
    z.strictObject({
      kind: z.literal('EXPLICIT'),
      jobs: z
        .array(benchmarkJobSchema)
        .min(1)
        .max(10_000)
        .refine(
          (jobs) => new Set(jobs.map((job) => job.id)).size === jobs.length,
          'Job IDs must be unique.',
        ),
    }),
  ]),
  algorithms: z
    .array(schedulingAlgorithmSchema)
    .min(1)
    .max(3)
    .refine(
      (algorithms) => new Set(algorithms).size === algorithms.length,
      'Algorithms must be unique.',
    ),
  printerModel: z.strictObject({
    count: z.number().int().min(1).max(64),
    pagesPerMinute: z.number().min(1).max(600),
    supportsColor: z.boolean(),
    supportsDuplex: z.boolean(),
  }),
  aging: agingConfigSchema
    .omit({ starvationWarningMs: true })
    .strict()
    .optional(),
  seed: nonNegativeIntSchema.max(4_294_967_295),
});

export type CreateJobRequest = z.input<typeof createJobRequestSchema>;
export type SubmitJobInput = z.infer<typeof submitJobSchema>;
export type UpdateJobRequest = z.infer<typeof updateJobRequestSchema>;
export type CreateBurstRequest = z.infer<typeof createBurstRequestSchema>;
export type BenchmarkJob = z.infer<typeof benchmarkJobSchema>;
export type BenchmarkRequest = z.infer<typeof benchmarkRequestSchema>;
