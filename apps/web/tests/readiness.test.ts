import { afterEach, expect, test, vi } from 'vitest';
import { fetchReadiness } from '../lib/api/readiness';
import { webEnvSchema } from '../lib/env';

afterEach(() => vi.unstubAllGlobals());
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
test('recognizes a typed 503 as connected but not ready', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(Response.json(health, { status: 503 }));
  vi.stubGlobal('fetch', fetch);
  expect(await fetchReadiness('http://localhost:4000')).toEqual(health);
  expect(fetch).toHaveBeenCalledWith(
    new URL('http://localhost:4000/health/ready'),
    expect.objectContaining({
      cache: 'no-store',
      signal: expect.any(AbortSignal),
    }),
  );
});
test('recognizes ready only when the payload and HTTP status agree', async () => {
  const ready = {
    ...health,
    status: 'ready',
    components: {
      configuration: 'ready',
      scheduler: 'ready',
      database: 'ready',
      migrations: 'ready',
      coordinator: 'ready',
      invariants: 'ready',
    },
  };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(ready)));
  expect(await fetchReadiness('http://localhost:4000')).toEqual(ready);
});
test.each([
  Response.json(health),
  Response.json({}, { status: 503 }),
  Response.json(health, { status: 500 }),
  new Response('not json', { status: 503 }),
])(
  'handles malformed or unexpected responses without inventing readiness',
  async (response) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    expect(await fetchReadiness('http://localhost:4000')).toBeNull();
  },
);
test('handles a disconnected or timed-out API', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockRejectedValue(new TypeError('fetch failed')),
  );
  expect(await fetchReadiness('http://localhost:4000')).toBeNull();
});
test('requires safe public origins and a server-side API origin', () => {
  const env = {
    API_INTERNAL_URL: 'http://localhost:4000',
    NEXT_PUBLIC_API_URL: 'http://localhost:4000',
    NEXT_PUBLIC_SOCKET_URL: 'http://localhost:4000',
  };
  expect(webEnvSchema.parse(env).NEXT_PUBLIC_APP_ENV).toBe('local');
  expect(webEnvSchema.safeParse({}).success).toBe(false);
  expect(
    webEnvSchema.safeParse({
      ...env,
      NEXT_PUBLIC_API_URL: 'https://user:secret@example.com',
    }).success,
  ).toBe(false);
});
