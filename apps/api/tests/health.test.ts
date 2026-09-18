import request from 'supertest';
import { pino } from 'pino';
import { expect, test } from 'vitest';
import {
  apiErrorResponseSchema,
  healthLiveSchema,
  healthReadySchema,
  uuidSchema,
} from '@printer/contracts';
import { createApp } from '../src/http/app.js';

const logger = pino({ enabled: false });
test('serves typed health, security headers, correlation IDs, and honest readiness', async () => {
  const app = createApp(logger, '0.1.0');
  const correlation = '00000000-0000-4000-8000-000000000001';
  const live = await request(app)
    .get('/health/live')
    .set('X-Correlation-Id', correlation)
    .expect(200);
  expect(healthLiveSchema.parse(live.body).status).toBe('alive');
  expect(live.headers['x-correlation-id']).toBe(correlation);
  expect(live.headers['x-content-type-options']).toBe('nosniff');
  expect(live.headers['x-powered-by']).toBeUndefined();
  expect(live.headers['cache-control']).toBe('no-store');
  const ready = await request(app)
    .get('/health/ready')
    .set('X-Correlation-Id', 'invalid')
    .expect(503);
  expect(healthReadySchema.parse(ready.body).components.database).toBe(
    'not_implemented',
  );
  expect(uuidSchema.safeParse(ready.headers['x-correlation-id']).success).toBe(
    true,
  );
  const missing = await request(app).get('/api/v1/jobs').expect(404);
  expect(apiErrorResponseSchema.parse(missing.body).error.code).toBe(
    'NOT_FOUND',
  );
});
test('rate limits public health checks with a retry header and typed error', async () => {
  const app = createApp(logger, '0.1.0');
  for (let i = 0; i < 120; i++)
    await request(app).get('/health/live').expect(200);
  const limited = await request(app).get('/health/live').expect(429);
  expect(apiErrorResponseSchema.parse(limited.body).error.code).toBe(
    'RATE_LIMITED',
  );
  expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
});
