import { z } from 'zod';

const origin = z.url({ protocol: /^https?$/ }).refine((value) => {
  const url = new URL(value);
  return !url.username && !url.password && url.origin === value;
}, 'Use an HTTP(S) origin without a path or credentials.');

export const webEnvSchema = z.object({
  API_INTERNAL_URL: origin,
  NEXT_PUBLIC_API_URL: origin,
  NEXT_PUBLIC_SOCKET_URL: origin,
  NEXT_PUBLIC_APP_ENV: z
    .enum(['local', 'development', 'test', 'staging', 'production'])
    .default('local'),
});

export function readWebEnv() {
  const result = webEnvSchema.safeParse(process.env);
  if (!result.success) {
    throw new Error(
      `Invalid web configuration: ${result.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
    );
  }
  return result.data;
}
