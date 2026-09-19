import { z } from 'zod';
import {
  errorCodeSchema,
  nonNegativeIntSchema,
  timestampSchema,
  uuidSchema,
} from './primitives.js';
import { jobResourceSchema } from './resources.js';

export const apiMetaSchema = z.object({
  requestId: uuidSchema,
  correlationId: uuidSchema,
  servedAt: timestampSchema,
  stateVersion: nonNegativeIntSchema.optional(),
});
export const apiErrorSchema = z.object({
  code: errorCodeSchema,
  message: z.string().min(1),
  retryable: z.boolean(),
  fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export const apiErrorResponseSchema = z.object({
  error: apiErrorSchema,
  meta: apiMetaSchema,
});
export const apiSuccessSchema = <T extends z.ZodType>(data: T) =>
  z.object({ data, meta: apiMetaSchema });
export const cursorPageSchema = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().min(1).optional(),
    hasMore: z.boolean(),
  });
export const burstResultSchema = z.object({
  accepted: z.array(jobResourceSchema),
  rejected: z.array(
    z.object({
      sourceIndex: nonNegativeIntSchema,
      code: errorCodeSchema,
      message: z.string(),
    }),
  ),
  seed: nonNegativeIntSchema.max(4_294_967_295),
  workloadHash: z.string().min(1),
});
export const benchmarkAcceptedSchema = z.object({
  benchmarkId: uuidSchema,
  status: z.enum(['QUEUED', 'RUNNING']),
  workloadHash: z.string().min(1),
  statusUrl: z.string().min(1),
});

export const healthLiveSchema = z.object({
  status: z.literal('alive'),
  version: z.string().min(1),
  uptimeSeconds: z.number().nonnegative(),
});
export const readinessComponentsSchema = z.object({
  configuration: z.enum(['ready', 'unavailable']),
  scheduler: z.enum(['ready', 'unavailable']),
  database: z.enum(['ready', 'unavailable', 'not_implemented']),
  migrations: z.enum(['ready', 'unavailable', 'not_implemented']),
  coordinator: z.enum(['ready', 'unavailable', 'not_implemented']),
  invariants: z.enum(['ready', 'unavailable', 'not_implemented']),
});
export const healthReadySchema = z
  .object({
    status: z.enum(['ready', 'not_ready']),
    version: z.string().min(1),
    components: readinessComponentsSchema,
  })
  .refine(
    (health) =>
      (health.status === 'ready') ===
      Object.values(health.components).every((status) => status === 'ready'),
    'Readiness must match all required component statuses.',
  );

export type ApiMeta = z.infer<typeof apiMetaSchema>;
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
export type ApiSuccess<T> = z.infer<
  ReturnType<typeof apiSuccessSchema<z.ZodType<T>>>
>;
export type HealthLive = z.infer<typeof healthLiveSchema>;
export type HealthReady = z.infer<typeof healthReadySchema>;
