import { expect, test } from '@playwright/test';
import { healthLiveSchema, healthReadySchema } from '@printer/contracts';

test('live dashboard submits and completes a job without refresh', async ({
  page,
  request,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const live = await request.get('http://127.0.0.1:4100/health/live');
  expect(live.status()).toBe(200);
  expect(healthLiveSchema.parse(await live.json()).status).toBe('alive');
  const ready = await request.get('http://127.0.0.1:4100/health/ready');
  expect(ready.status()).toBe(200);
  expect(healthReadySchema.parse(await ready.json()).status).toBe('ready');

  await page.goto('/');
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Live operations',
  );
  await expect(page.getByRole('status')).toContainText(
    'Live connection active',
  );
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('link', { name: 'Skip to content' }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
  const jobName = `E2E ${testInfo.project.name} ${Date.now()}`;
  await page.getByLabel('Document name').fill(jobName);
  await page.getByLabel('Pages').fill('4');
  await page.getByRole('button', { name: 'Submit job' }).click();
  const row = page.getByRole('row').filter({ hasText: jobName });
  await expect(row).toBeVisible();
  await expect(row).toContainText('PRINTING');
  const printer = page.locator('article').filter({ hasText: jobName });
  await printer.getByRole('button', { name: 'Jam' }).click();
  await expect(row).toContainText('PAUSED');
  await expect(printer).toContainText('JAMMED');
  await printer.getByRole('button', { name: 'Recover' }).click();
  await expect(row).toContainText('COMPLETED', { timeout: 10_000 });
  await expect(
    page.getByText('job.completed', { exact: true }).first(),
  ).toBeVisible();
  await page.getByLabel('Role').selectOption('VIEWER');
  await expect(page.getByText('Viewer mode is read-only')).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath('foundation.png'),
    fullPage: true,
  });
});
