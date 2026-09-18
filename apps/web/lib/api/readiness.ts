import { healthReadySchema } from '@printer/contracts';

export async function fetchReadiness(apiOrigin: string) {
  try {
    const response = await fetch(new URL('/health/ready', apiOrigin), {
      cache: 'no-store',
      signal: AbortSignal.timeout(3_000),
    });
    if (response.status !== 200 && response.status !== 503) return null;
    const health = healthReadySchema.parse(await response.json());
    if ((response.status === 200) !== (health.status === 'ready')) return null;
    return health;
  } catch {
    return null;
  }
}
