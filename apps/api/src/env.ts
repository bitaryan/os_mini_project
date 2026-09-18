import { z } from 'zod';
import { schedulingAlgorithmSchema } from '@printer/contracts';

const integer = (min: number, max: number, fallback: string) =>
  z
    .string()
    .regex(/^\d+$/)
    .default(fallback)
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));
const boolean = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');
const origin = z.url({ protocol: /^https?$/ }).refine((value) => {
  const url = new URL(value);
  return !url.username && !url.password && url.origin === value;
}, 'Use an exact HTTP(S) origin without a path or credentials.');

export const apiEnvSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: integer(1, 65_535, '4000'),
  WEB_ORIGIN: origin,
  DATABASE_URL: z.string().refine((value) => {
    if (value.startsWith('file:')) return value.slice(5).trim().length > 0;
    try {
      const url = new URL(value);
      return (
        ['postgres:', 'postgresql:'].includes(url.protocol) &&
        !!url.hostname &&
        url.pathname.length > 1
      );
    } catch {
      return false;
    }
  }, 'Use a PostgreSQL URL or a nonempty file: path.'),
  SESSION_SECRET: z.string().min(32),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  QUEUE_CAPACITY: integer(1, 100_000, '1000'),
  DEFAULT_ALGORITHM: schedulingAlgorithmSchema.default('FCFS'),
  AGING_INTERVAL_MS: integer(1_000, 300_000, '5000'),
  AGING_FACTOR: integer(1, 25, '2'),
  PRIORITY_CAP: integer(1, 100, '100'),
  STARVATION_WARNING_MS: integer(5_000, 3_600_000, '30000'),
  SIMULATION_TICK_MS: integer(1, 10_000, '250'),
  WATCHDOG_STUCK_MS: integer(1_000, 3_600_000, '15000'),
  WORKER_LEASE_MS: integer(1_000, 300_000, '5000'),
  ENABLE_FAULT_INJECTION: boolean.default(false),
  AUTH_MODE: z.literal('local').default('local'),
  TRUST_PROXY: z
    .union([
      z.literal('false').transform(() => false as const),
      z
        .string()
        .regex(/^\d+$/)
        .transform(Number)
        .pipe(z.number().int().min(0).max(10)),
    ])
    .default(false),
});
export type ApiEnv = z.infer<typeof apiEnvSchema>;
