import { test, expect } from '@playwright/test';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { startUiServer } from '../src/server.mjs';

let runtime;
let baseUrl;
const execFile = promisify(execFileCb);

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

test('C3 dual-ID shell + command flow reaches terminal status', async ({ page }) => {
  await page.goto(baseUrl);

  await expect(page.locator('#conversation-plane')).toBeVisible();
  await expect(page.locator('#execution-plane')).toBeVisible();
  await expect(page.locator('#artifact-plane')).toBeVisible();
  await expect(page.locator('#conv')).toBeVisible();
  await expect(page.locator('#exec')).toBeVisible();
  await expect(page.locator('#artifacts')).toBeVisible();

  await page.fill('#cmd-input', '/doc alpha beta gamma');
  await page.click('#command-form button[type="submit"]');
  await expect(page.locator('#run-status')).toContainText('running:', { timeout: 10_000 });
  await expect(page.locator('#run-status')).toContainText('done:', { timeout: 30_000 });
  await expect(page.locator('#run-status')).toHaveAttribute('data-state', 'done');

  await expect(page.locator('#timeline li[data-function-id=\"0\"]')).toContainText('0:prepare:ok');
  await expect(page.locator('#timeline li[data-function-id=\"1\"]')).toContainText('1:DBOS.sleep:ok');
  await expect(page.locator('#timeline li[data-function-id=\"4\"]')).toContainText('4:persist-artifacts:ok');
  await expect(page.locator('#timeline li[data-function-id=\"5\"]')).toContainText('5:artifact-count:ok');
  await expect(page.locator('#artifacts li').first()).toBeVisible({ timeout: 15_000 });
});

test('C3 direct artifact URL returns full page shell (non-HX)', async ({ request }) => {
  const create = await request.post(`${baseUrl}/runs`, {
    data: { cmd: '/doc alpha beta gamma' }
  });
  expect(create.status()).toBe(202);
  const started = await create.json();
  expect(started.run_id).toBeTruthy();

  let artifactId = '';
  for (let i = 0; i < 80; i += 1) {
    const runRes = await request.get(
      `http://127.0.0.1:${runtime.apiPort}/runs/${encodeURIComponent(started.run_id)}`
    );
    expect(runRes.status()).toBe(200);
    const run = await runRes.json();
    if (run.status === 'done') {
      const listRes = await request.get(`http://127.0.0.1:${runtime.apiPort}/artifacts`);
      expect(listRes.status()).toBe(200);
      const list = await listRes.json();
      const first = Array.isArray(list) ? list[0] : null;
      artifactId = first?.id ?? '';
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(artifactId).not.toBe('');

  const pageRes = await request.get(`${baseUrl}/artifacts/${encodeURIComponent(artifactId)}`);
  expect(pageRes.status()).toBe(200);
  const html = await pageRes.text();
  expect(html).toContain('<main id="main"');
  expect(html).toContain('id="conversation-plane"');
  expect(html).toContain('id="artifact-plane"');
});

test('C3 HX polling endpoint returns OOB updates for exec+artifacts+status', async ({ request }) => {
  const create = await request.post(`${baseUrl}/runs`, {
    data: { cmd: '/doc alpha beta gamma', sleepMs: 200 }
  });
  expect(create.status()).toBe(202);
  const started = await create.json();

  const pollRes = await request.get(`${baseUrl}/ui/runs/${encodeURIComponent(started.run_id)}/poll`, {
    headers: { 'HX-Request': 'true' }
  });
  expect(pollRes.status()).toBe(200);
  const html = await pollRes.text();
  expect(html).toContain('id="exec"');
  expect(html).toContain('id="artifacts" hx-swap-oob="true"');
  expect(html).toContain('id="run-status"');
  expect(html).toContain('hx-swap-oob="true"');
});

test('C4 artifact viewer deep-link focuses producing execution step', async ({ page, request }) => {
  const create = await request.post(`${baseUrl}/runs`, {
    data: { cmd: '/doc c4-deep-link' }
  });
  expect(create.status()).toBe(202);
  const started = await create.json();

  let run = null;
  for (let i = 0; i < 120; i += 1) {
    const runRes = await request.get(
      `http://127.0.0.1:${runtime.apiPort}/runs/${encodeURIComponent(started.run_id)}`
    );
    expect(runRes.status()).toBe(200);
    run = await runRes.json();
    if (run.status === 'done') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(run?.status).toBe('done');

  const listRes = await request.get(`http://127.0.0.1:${runtime.apiPort}/artifacts?type=raw`);
  expect(listRes.status()).toBe(200);
  const list = await listRes.json();
  const artifactId = Array.isArray(list) ? list.find((row) => row.run_id === started.run_id)?.id : '';
  expect(artifactId).toBeTruthy();

  await page.goto(`${baseUrl}/artifacts/${encodeURIComponent(artifactId)}`);
  await page.click('a:has-text("open sources")');
  await expect(page.locator('#timeline li.step-focus')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#timeline li.step-focus')).toContainText('persist-artifacts');
});

test('C4 resume control resumes cancelled run', async ({ page, request }) => {
  const create = await request.post(`${baseUrl}/runs`, {
    data: { cmd: '/doc c4-ui-resume', sleepMs: 3000 }
  });
  expect(create.status()).toBe(202);
  const started = await create.json();
  const runId = started.run_id;

  for (let i = 0; i < 60; i += 1) {
    const runRes = await request.get(`http://127.0.0.1:${runtime.apiPort}/runs/${encodeURIComponent(runId)}`);
    expect(runRes.status()).toBe(200);
    const run = await runRes.json();
    if (run.status === 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  await execFile(
    'pnpm',
    [
      '--filter',
      '@jejakekal/api',
      'exec',
      'dbos',
      'workflow',
      'cancel',
      '-s',
      String(process.env.DBOS_SYSTEM_DATABASE_URL),
      runId
    ],
    { cwd: process.cwd() }
  );

  for (let i = 0; i < 60; i += 1) {
    const runRes = await request.get(`http://127.0.0.1:${runtime.apiPort}/runs/${encodeURIComponent(runId)}`);
    expect(runRes.status()).toBe(200);
    const run = await runRes.json();
    if (run.dbos_status === 'CANCELLED') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  await page.goto(`${baseUrl}/runs/${encodeURIComponent(runId)}`);
  await expect(page.locator('#resume-form')).toBeVisible({ timeout: 10_000 });
  await page.click('#resume-form button[type="submit"]');
  await expect(page.locator('#run-status')).toContainText('running:', { timeout: 10_000 });
  await expect(page.locator('#run-status')).toContainText('done:', { timeout: 30_000 });
  await expect(page.locator('#run-status')).toHaveAttribute('data-state', 'done');
});
