import { expect, test } from '@playwright/test';
import { healthLiveSchema, healthReadySchema } from '@printer/contracts';

test('built web and API agree on readiness, support keyboard access and fit the viewport', async ({
  page,
  request,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const live = await request.get('http://127.0.0.1:4100/health/live');
  expect(live.status()).toBe(200);
  expect(healthLiveSchema.parse(await live.json()).status).toBe('alive');
  const ready = await request.get('http://127.0.0.1:4100/health/ready');
  expect(ready.status()).toBe(503);
  expect(healthReadySchema.parse(await ready.json()).status).toBe('not_ready');

  await page.goto('/');
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'System overview',
  );
  await expect(page.getByRole('status')).toContainText('API connected');
  await expect(page.getByText('Not built yet', { exact: true })).toHaveCount(4);
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('link', { name: 'Skip to content' }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
  await page.getByRole('link', { name: 'Check again' }).click();
  await expect(page.getByRole('status')).toContainText('API connected');
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
