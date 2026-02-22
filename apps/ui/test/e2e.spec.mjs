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
  await expect(page.locator('#run-status')).toHaveAttribute('data-state', 'done');

  await expect(page.locator('#timeline li')).toHaveCount(6);
  await expect(page.locator('#timeline li').first()).toContainText('run_id=');
  await expect(page.locator('#timeline li[data-function-id=\"0\"]')).toContainText('0:prepare:ok');
  await expect(page.locator('#timeline li[data-function-id=\"1\"]')).toContainText('1:DBOS.sleep:ok');
  await expect(page.locator('#artifacts li')).toHaveCount(4);
  await expect(page.locator('[data-artifact-id="memo"]')).toBeVisible();
});

test('ui polling remains stable for long-running workflow when timeout configured', async ({ page }) => {
  await page.goto('http://127.0.0.1:4110/?sleepMs=6500&pollTimeoutMs=20000&pollIntervalMs=25');

  await page.click('#run-workflow');
  await expect(page.locator('#run-status')).toContainText('running');
  await expect(page.locator('#run-status')).toContainText('done:', { timeout: 30_000 });
  await expect(page.locator('#run-status')).toHaveAttribute('data-state', 'done');
});
