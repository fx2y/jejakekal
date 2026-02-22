import { test, expect } from '@playwright/test';
import { startUiServer } from '../src/server.mjs';

let runtime;
let baseUrl;

test.beforeAll(async () => {
  try {
    runtime = await startUiServer(0, { apiPort: 0 });
  } catch (error) {
    throw new Error(`ui e2e startup failed: ${String(error)}`);
  }
  baseUrl = `http://127.0.0.1:${runtime.uiPort}`;
});

test.afterAll(async () => {
  await runtime?.close();
});

test('C0 HX branch probe reports full vs fragment decision', async ({ request }) => {
  const nonHx = await request.get(`${baseUrl}/__probe/hx-branch`);
  expect(nonHx.status()).toBe(200);
  expect(await nonHx.json()).toEqual({
    hx_request: false,
    hx_history_restore_request: false,
    full_document: true
  });

  const hx = await request.get(`${baseUrl}/__probe/hx-branch`, {
    headers: { 'HX-Request': 'true' }
  });
  expect(hx.status()).toBe(200);
  expect(await hx.json()).toEqual({
    hx_request: true,
    hx_history_restore_request: false,
    full_document: false
  });

  const hxRestore = await request.get(`${baseUrl}/__probe/hx-branch`, {
    headers: { 'HX-Request': 'true', 'HX-History-Restore-Request': 'true' }
  });
  expect(hxRestore.status()).toBe(200);
  expect(await hxRestore.json()).toEqual({
    hx_request: true,
    hx_history_restore_request: true,
    full_document: true
  });
});

test('3-plane product promise path (ingest -> timeline -> artifacts)', async ({ page }) => {
  await page.goto(baseUrl);

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
  await page.goto(`${baseUrl}/?sleepMs=6500&pollTimeoutMs=20000&pollIntervalMs=25`);

  await page.click('#run-workflow');
  await expect(page.locator('#run-status')).toContainText('running');
  await expect(page.locator('#run-status')).toContainText('done:', { timeout: 30_000 });
  await expect(page.locator('#run-status')).toHaveAttribute('data-state', 'done');
});
