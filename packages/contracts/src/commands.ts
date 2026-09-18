import { z } from 'zod';
import {
  agentNameSchema,
  durationSchema,
  nonNegativeIntSchema,
  timestampSchema,
  uuidSchema,
} from './primitives.js';

const commandSchema = <
  T extends string,
  A extends z.ZodType,
  P extends z.ZodType,
>(
  type: T,
  agent: A,
  payload: P,
) =>
  z.strictObject({
    commandId: uuidSchema,
    agent,
    type: z.literal(type),
    issuedAt: timestampSchema,
    expectedStateVersion: nonNegativeIntSchema,
    correlationId: uuidSchema,
    payload,
  });
export const agentCommandSchema = z.discriminatedUnion('type', [
  commandSchema(
    'DISPATCH_NEXT_JOB',
    z.literal('automation-daemon'),
    z.strictObject({
      printerId: uuidSchema,
      schedulerRevision: nonNegativeIntSchema,
    }),
  ),
  commandSchema(
    'ADVANCE_ACTIVE_JOB',
    z.literal('automation-daemon'),
    z.strictObject({
      printerId: uuidSchema,
      elapsedSimulationMs: durationSchema,
      workerLeaseId: uuidSchema,
    }),
  ),
  commandSchema(
    'FENCE_WORKER',
    z.literal('watchdog-intercept'),
    z.strictObject({
      printerId: uuidSchema,
      staleLeaseId: uuidSchema,
      reason: z.enum(['STUCK_JOB', 'LEASE_EXPIRED']),
    }),
  ),
  commandSchema(
    'FORCE_RELEASE_MUTEX',
    z.literal('watchdog-intercept'),
    z.strictObject({
      printerId: uuidSchema,
      fencedLeaseId: uuidSchema,
      expectedFenceToken: nonNegativeIntSchema,
    }),
  ),
  commandSchema(
    'RECOVER_INTERRUPTED_JOB',
    z.literal('watchdog-intercept'),
    z.strictObject({
      jobId: uuidSchema,
      action: z.enum(['REQUEUE', 'FAIL']),
      preservePagesCompleted: z.literal(true),
    }),
  ),
  commandSchema(
    'ASSIGN_PRINTER',
    z.literal('load-balancer'),
    z.strictObject({
      jobId: uuidSchema,
      printerId: uuidSchema,
      reservationTtlMs: z.number().int().min(1).max(2_000),
    }),
  ),
  commandSchema(
    'RECOMPUTE_EFFECTIVE_PRIORITIES',
    z.literal('starvation-guard'),
    z.strictObject({
      evaluatedAtMs: durationSchema,
      configRevision: nonNegativeIntSchema,
    }),
  ),
]);
export const agentCommandResultSchema = z.object({
  commandId: uuidSchema,
  accepted: z.boolean(),
  resultingStateVersion: nonNegativeIntSchema,
  errorCode: z
    .enum([
      'STATE_VERSION_CONFLICT',
      'INVARIANT_VIOLATION',
      'LOCK_NOT_OWNED',
      'CIRCUIT_OPEN',
      'INVALID_TRANSITION',
    ])
    .optional(),
  message: z.string().optional(),
});
export const toolContextSchema = z.strictObject({
  actor: z.strictObject({
    kind: z.enum(['AGENT', 'OPERATOR', 'SYSTEM']),
    id: z.string().min(1),
  }),
  commandId: uuidSchema,
  correlationId: uuidSchema,
  expectedStateVersion: nonNegativeIntSchema,
  requestedAt: timestampSchema,
});
export const agentEventSchema = <T extends string, P extends z.ZodType>(
  type: T,
  payload: P,
) =>
  z.strictObject({
    eventId: uuidSchema,
    type: z.literal(type),
    occurredAt: timestampSchema,
    correlationId: uuidSchema,
    stateVersion: nonNegativeIntSchema,
    payload,
  });
export { agentNameSchema };
export type AgentCommand = z.infer<typeof agentCommandSchema>;
export type AgentCommandResult = z.infer<typeof agentCommandResultSchema>;
