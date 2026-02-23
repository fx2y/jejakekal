import { test, expect } from '@playwright/test';
import { execFile as execFileCb } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { promisify } from 'node:util';
import { startUiServer } from '../src/server.mjs';

let runtime;
let baseUrl;
const execFile = promisify(execFileCb);

function rawHttp(req) {
  return new Promise((resolve, reject) => {
    const pending = httpRequest(
      {
        host: '127.0.0.1',
        port: req.port,
        method: req.method,
        path: req.path,
        headers: req.headers
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          let json = null;
          try {
            json = body.length > 0 ? JSON.parse(body) : null;
          } catch {
            json = null;
          }
          resolve({
            status: res.statusCode ?? 0,
            text: body,
            json
          });
        });
      }
    );
    pending.on('error', reject);
    pending.end();
  });
}

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
  await expect(page.locator('#exec')).toHaveAttribute('hx-trigger', 'every 1s');
  await expect(page.locator('#run-status')).toContainText('done:', { timeout: 30_000 });
  await expect(page.locator('#run-status')).toHaveAttribute('data-state', 'done');
  await expect(page.locator('#conv')).not.toContainText('alpha beta gamma');

  await expect(page.locator('#timeline li[data-function-id=\"0\"]')).toContainText('0:reserve-doc:ok');
  await expect(page.locator('#timeline li[data-function-id=\"2\"]')).toContainText('2:DBOS.sleep:ok');
  await expect(page.locator('#timeline li[data-function-id=\"4\"]')).toContainText('4:store-parse-outputs:ok');
  await expect(page.locator('#timeline li[data-function-id=\"5\"]')).toContainText('5:artifact-count:ok');
  await expect(page.locator('#artifacts li').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#artifacts')).toContainText('source_count=1');
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
  expect(html).toContain('id="exec" hx-swap-oob="true"');
  expect(html).toContain('id="artifacts" hx-swap-oob="true"');
  expect(html).toContain('id="run-status"');
  expect(html).toContain('hx-swap-oob="true"');
});

test('C5 HX history restore on run route returns full page shell', async ({ request }) => {
  const create = await request.post(`${baseUrl}/runs`, {
    data: { cmd: '/doc c5-history-restore' }
  });
  expect(create.status()).toBe(202);
  const started = await create.json();

  for (let i = 0; i < 120; i += 1) {
    const runRes = await request.get(
      `http://127.0.0.1:${runtime.apiPort}/runs/${encodeURIComponent(started.run_id)}`
    );
    expect(runRes.status()).toBe(200);
    const run = await runRes.json();
    if (run.status === 'done') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const restoreRes = await request.get(`${baseUrl}/runs/${encodeURIComponent(started.run_id)}`, {
    headers: { 'HX-Request': 'true', 'HX-History-Restore-Request': 'true' }
  });
  expect(restoreRes.status()).toBe(200);
  const html = await restoreRes.text();
  expect(html).toContain('<!doctype html>');
  expect(html).toContain('id="main"');
  expect(html).toContain('id="execution-plane"');
});

test('C6 UI raw-path boundaries return typed/parity-safe errors and no idle poll masking', async () => {
  const badRun = await rawHttp({
    port: runtime.uiPort,
    method: 'GET',
    path: '/runs/%2E%2E'
  });
  expect(badRun.status).toBe(400);
  expect(badRun.text).toContain('<!doctype html>');
  expect(badRun.text).toContain('id="run-status" data-state="error"');
  expect(badRun.text).toContain('error:invalid_run_id');

  const badArtifact = await rawHttp({
    port: runtime.uiPort,
    method: 'GET',
    path: '/artifacts/%2E%2E'
  });
  expect(badArtifact.status).toBe(400);
  expect(badArtifact.text).toContain('id="run-status" data-state="error"');
  expect(badArtifact.text).toContain('error:invalid_artifact_id');

  const badPollMalformed = await rawHttp({
    port: runtime.uiPort,
    method: 'GET',
    path: '/ui/runs/%ZZ/poll',
    headers: { 'HX-Request': 'true' }
  });
  expect(badPollMalformed.status).toBe(400);
  expect(badPollMalformed.text).toContain('data-state="error"');
  expect(badPollMalformed.text).not.toContain('data-state="idle"');

  const badPollTraversal = await rawHttp({
    port: runtime.uiPort,
    method: 'GET',
    path: '/ui/runs/%2E%2E/poll',
    headers: { 'HX-Request': 'true' }
  });
  expect(badPollTraversal.status).toBe(400);
  expect(badPollTraversal.text).toContain('data-state="error"');
});

test('C8 run route artifact pane is run-scoped by default with explicit global escape hatch', async ({
  request
}) => {
  const runOne = await request.post(`${baseUrl}/runs`, {
    data: { cmd: '/doc c8-run-one' }
  });
  expect(runOne.status()).toBe(202);
  const startedOne = await runOne.json();

  const runTwo = await request.post(`${baseUrl}/runs`, {
    data: { cmd: '/doc c8-run-two' }
  });
  expect(runTwo.status()).toBe(202);
  const startedTwo = await runTwo.json();

  for (let i = 0; i < 120; i += 1) {
    const [oneRes, twoRes] = await Promise.all([
      request.get(`http://127.0.0.1:${runtime.apiPort}/runs/${encodeURIComponent(startedOne.run_id)}`),
      request.get(`http://127.0.0.1:${runtime.apiPort}/runs/${encodeURIComponent(startedTwo.run_id)}`)
    ]);
    expect(oneRes.status()).toBe(200);
    expect(twoRes.status()).toBe(200);
    const [one, two] = await Promise.all([oneRes.json(), twoRes.json()]);
    if (one.status === 'done' && two.status === 'done') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const runPage = await request.get(`${baseUrl}/runs/${encodeURIComponent(startedOne.run_id)}`);
  expect(runPage.status()).toBe(200);
  const html = await runPage.text();
  expect(html).toContain(`scope=run:${startedOne.run_id}`);
  expect(html).toContain('/artifacts');
  expect(html).not.toContain(`/runs/${startedTwo.run_id}`);
});

test('C6 direct missing run route renders full shell with error state (not idle)', async ({ request }) => {
  const res = await request.get(`${baseUrl}/runs/does-not-exist`);
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toContain('id="conversation-plane"');
  expect(html).toContain('id="run-status" data-state="error"');
  expect(html).toContain('Run not found.');
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
  await expect(page.locator('#timeline li.step-focus')).toContainText('store-raw');
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
