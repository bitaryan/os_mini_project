import { defineConfig, devices } from '@playwright/test';

const webOrigin = 'http://127.0.0.1:3100';
const apiOrigin = 'http://127.0.0.1:4100';
const databaseUrl = `file:./data/e2e-${process.pid}.db`;

export default defineConfig({
  testDir: './tests/e2e',
  // Both viewport projects intentionally exercise the same persisted simulation.
  workers: 1,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  reporter: 'list',
  use: { baseURL: webOrigin, trace: 'retain-on-failure' },
  projects: [
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 1000 },
      },
    },
    {
      name: 'mobile',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 360, height: 800 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: [
    {
      command:
        'pnpm --filter @printer/api db:migrate && pnpm --filter @printer/api start',
      url: `${apiOrigin}/health/live`,
      env: {
        NODE_ENV: 'test',
        PORT: '4100',
        WEB_ORIGIN: webOrigin,
        DATABASE_URL: databaseUrl,
        SESSION_SECRET: 'test-only-value-not-a-real-secret-0000',
        LOG_LEVEL: 'silent',
        ENABLE_FAULT_INJECTION: 'true',
      },
      reuseExistingServer: false,
    },
    {
      command:
        'pnpm --filter @printer/web start --port 3100 --hostname 127.0.0.1',
      url: webOrigin,
      env: {
        API_INTERNAL_URL: apiOrigin,
        NEXT_PUBLIC_API_URL: apiOrigin,
        NEXT_PUBLIC_SOCKET_URL: apiOrigin,
        NEXT_PUBLIC_APP_ENV: 'test',
      },
      reuseExistingServer: false,
    },
  ],
});
