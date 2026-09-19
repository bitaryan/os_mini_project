import { z } from 'zod';

export const uuidSchema = z.uuid();
export const timestampSchema = z.iso.datetime();
export const nonNegativeIntSchema = z.number().int().nonnegative();
export const durationSchema = nonNegativeIntSchema;
export const prioritySchema = z.number().int().min(0).max(100);
export const pagesSchema = z.number().int().min(1).max(10_000);
export const colorModeSchema = z.enum(['MONO', 'COLOR']);
export const speedMultiplierSchema = z.union([
  z.literal(0.25),
  z.literal(0.5),
  z.literal(1),
  z.literal(2),
  z.literal(4),
]);
export const schedulingAlgorithmSchema = z.enum([
  'FCFS',
  'SJF',
  'PRIORITY_AGING',
]);
export const jobStatusSchema = z.enum([
  'QUEUED',
  'READY',
  'PRINTING',
  'PAUSED',
  'BLOCKED',
  'COMPLETED',
  'CANCELLED',
  'FAILED',
]);
export const printerStatusSchema = z.enum([
  'READY',
  'RESERVED',
  'PRINTING',
  'JAMMED',
  'ERROR',
  'OFFLINE',
]);
export const agentNameSchema = z.enum([
  'automation-daemon',
  'watchdog-intercept',
  'load-balancer',
  'starvation-guard',
  'metrics-evaluator',
]);
export const roleSchema = z.enum(['VIEWER', 'OPERATOR', 'ADMIN']);
export const errorCodeSchema = z.enum([
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'UNSUPPORTED_MEDIA_TYPE',
  'IDEMPOTENCY_KEY_REQUIRED',
  'IDEMPOTENCY_CONFLICT',
  'STATE_VERSION_CONFLICT',
  'JOB_VERSION_CONFLICT',
  'QUEUE_CAPACITY_EXCEEDED',
  'INVALID_TRANSITION',
  'NO_COMPATIBLE_PRINTER',
  'RESOURCE_BUSY',
  'LOCK_NOT_OWNED',
  'LEASE_EXPIRED',
  'FENCE_TOKEN_MISMATCH',
  'INVARIANT_VIOLATION',
  'FAULT_INJECTION_DISABLED',
  'CIRCUIT_OPEN',
  'RATE_LIMITED',
  'BENCHMARK_LIMIT_EXCEEDED',
  'PERSISTENCE_UNAVAILABLE',
  'RESYNC_REQUIRED',
  'INTERNAL_ERROR',
]);

export type JobStatus = z.infer<typeof jobStatusSchema>;
export type PrinterStatus = z.infer<typeof printerStatusSchema>;
export type SchedulingAlgorithm = z.infer<typeof schedulingAlgorithmSchema>;
export type SpeedMultiplier = z.infer<typeof speedMultiplierSchema>;
export type ErrorCode = z.infer<typeof errorCodeSchema>;
