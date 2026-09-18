import { expect, test } from 'vitest';
import { apiEnvSchema } from '../src/env.js';

const env = {
  WEB_ORIGIN: 'http://localhost:3000',
  DATABASE_URL: 'file:./data/test.db',
  SESSION_SECRET: 'test-only-value-not-a-real-secret-0000',
};
test('parses documented defaults and false flags without truthiness coercion', () => {
  const parsed = apiEnvSchema.parse({
    ...env,
    ENABLE_FAULT_INJECTION: 'false',
    TRUST_PROXY: 'false',
  });
  expect(parsed.PORT).toBe(4000);
  expect(parsed.ENABLE_FAULT_INJECTION).toBe(false);
  expect(parsed.TRUST_PROXY).toBe(false);
  expect(apiEnvSchema.parse({ ...env, TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1);
});
test.each([
  { PORT: '' },
  { PORT: '0' },
  { PORT: '65536' },
  { PORT: '4e3' },
  { AGING_FACTOR: '26' },
  { WEB_ORIGIN: 'https://user:pass@example.com' },
  { WEB_ORIGIN: 'http://localhost:3000/path' },
  { DATABASE_URL: 'file:' },
  { DATABASE_URL: 'https://example.com/db' },
  { SESSION_SECRET: '' },
  { ENABLE_FAULT_INJECTION: 'yes' },
  { TRUST_PROXY: 'true' },
])('rejects invalid configuration %j', (patch) => {
  expect(apiEnvSchema.safeParse({ ...env, ...patch }).success).toBe(false);
});
