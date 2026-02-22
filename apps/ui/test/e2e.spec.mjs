import { test, expect } from '@playwright/test';
import { startUiServer } from '../src/server.mjs';

let runtime;

test.beforeAll(async () => {
  runtime = await startUiServer(4110);
});

test.afterAll(async () => {
  await runtime?.close();
});

test('3-plane product promise path (ingest -> timeline -> artifacts)', async ({ page }) => {
  await page.goto('http://127.0.0.1:4110');

  await expect(page.locator('#conversation-plane')).toBeVisible();
  await expect(page.locator('#execution-plane')).toBeVisible();
  await expect(page.locator('#artifact-plane')).toBeVisible();

  await page.click('#run-workflow');
  await expect(page.locator('#run-status')).toContainText('done:');

  await expect(page.locator('#timeline li')).toHaveCount(6);
  await expect(page.locator('#artifacts li')).toHaveCount(4);
  await expect(page.locator('[data-artifact-id="memo"]')).toBeVisible();
});
