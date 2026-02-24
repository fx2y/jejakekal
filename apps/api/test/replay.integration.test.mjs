import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFile as execFileCb } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { ensureDbosRuntime, shutdownDbosRuntime } from '../src/dbos-runtime.mjs';
import { startFlakyRetryWorkflowRun } from '../src/dbos-workflows.mjs';
import { getRunProjection } from '../src/runs-projections.mjs';
import { closeServer, listenLocal } from '../src/http.mjs';
import {
  connectDbOrSkip,
  nextWorkflowId,
  resetAppDb,
  setupDbOrSkip,
  startApiProcess,
  waitForCondition
} from './helpers.mjs';
import { freezeDeterminism } from '../../../packages/core/src/determinism.mjs';

const execFile = promisify(execFileCb);

async function startMockOcrServer() {
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: [{ type: 'text', text: 'ocr text' }] } }]
      })
    );
  });
  const port = await listenLocal(server, 0);
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => closeServer(server)
  };
}

async function postRun(baseUrl, body) {
  const res = await fetch(`${baseUrl}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  assert.equal(res.status, 202);
  return res.json();
}

function parseCliJson(stdout) {
  return JSON.parse(stdout.toString().trim());
}

async function runDbosCli(command, runId) {
  const { stdout } = await execFile(
    'pnpm',
    [
      '--filter',
      '@jejakekal/api',
      'exec',
      'dbos',
      'workflow',
      command,
      '-s',
      String(process.env.DBOS_SYSTEM_DATABASE_URL),
      runId
    ],
    { cwd: process.cwd() }
  );
  return parseCliJson(stdout);
}

async function runDbosCliNoOutput(command, runId) {
  await execFile(
    'pnpm',
    [
      '--filter',
      '@jejakekal/api',
      'exec',
      'dbos',
      'workflow',
      command,
      '-s',
      String(process.env.DBOS_SYSTEM_DATABASE_URL),
      runId
    ],
    { cwd: process.cwd() }
  );
}

test('C4 kill9: SIGKILL during DBOS.sleep resumes from last completed step', async (t) => {
  if (!(await setupDbOrSkip(t))) return;
  const unfreeze = freezeDeterminism({ now: Date.parse('2026-02-22T00:00:00.000Z'), random: 0.25 });
  t.after(() => unfreeze());

  let api = await startApiProcess();
  const initialApi = api;
  t.after(async () => {
    await initialApi.stop();
  });

  await api.waitForHealth();
  const started = await postRun(api.baseUrl, { source: 'c4-kill9', sleepMs: 800 });
  const runId = started.run_id;
  assert.equal(typeof runId, 'string');

  await waitForCondition(
    async () => {
      const run = await api.readRun(runId);
      if (!run) return false;
      return run.timeline.some((step) => step.function_name === 'reserve-doc');
    },
    { timeoutMs: 10_000, intervalMs: 50, label: `reserve-doc row for ${runId}` }
  );

  await api.kill('SIGKILL');
  api = await startApiProcess({ port: api.port });
  const resumedApi = api;
  t.after(async () => {
    await resumedApi.stop();
  });
  await api.waitForHealth();

  const done = await api.waitForRunTerminal(runId, 20_000);
  assert.equal(done?.status, 'done');
  const steps = done.timeline;
  assert.equal(steps.filter((step) => step.function_name === 'reserve-doc').length, 1);
  assert.equal(steps.filter((step) => step.function_name === 'DBOS.sleep').length, 1);
});

test('C4 durable-start: kill right after POST /runs response still reaches terminal after restart', async (t) => {
  if (!(await setupDbOrSkip(t))) return;
  const unfreeze = freezeDeterminism({ now: Date.parse('2026-02-22T00:00:00.000Z'), random: 0.25 });
  t.after(() => unfreeze());

  let api = await startApiProcess();
  const initialApi = api;
  t.after(async () => {
    await initialApi.stop();
  });
  await api.waitForHealth();

  const started = await postRun(api.baseUrl, { source: 'c4-durable', sleepMs: 600 });
  const runId = started.run_id;
  await api.kill('SIGKILL');

  api = await startApiProcess({ port: api.port });
  const resumedApi = api;
  t.after(async () => {
    await resumedApi.stop();
  });
  await api.waitForHealth();

  let done = await api.waitForRunTerminal(runId, 20_000);
  if (done?.status === 'error') {
    assert.equal(['CANCELLED', 'RETRIES_EXCEEDED'].includes(String(done.dbos_status)), true);
    const resumeRes = await fetch(`${api.baseUrl}/runs/${encodeURIComponent(runId)}/resume`, { method: 'POST' });
    assert.equal(resumeRes.status, 202);
    done = await api.waitForRunTerminal(runId, 20_000);
  }
  assert.equal(done?.status, 'done');
  assert.equal(done?.dbos_status, 'SUCCESS');
});

test('C6 artifact blobs survive SIGKILL restart for detail/download', async (t) => {
  if (!(await setupDbOrSkip(t))) return;
  const unfreeze = freezeDeterminism({ now: Date.parse('2026-02-22T00:00:00.000Z'), random: 0.25 });
  t.after(() => unfreeze());
  const bundlesRoot = await mkdtemp(join(tmpdir(), 'jejakekal-c6-kill9-bundles-'));
  t.after(async () => {
    await rm(bundlesRoot, { recursive: true, force: true });
  });

  let api = await startApiProcess({
    env: {
      JEJAKEKAL_BUNDLES_ROOT: bundlesRoot
    }
  });
  const initialApi = api;
  t.after(async () => {
    await initialApi.stop();
  });
  await api.waitForHealth();

  const started = await postRun(api.baseUrl, { source: 'c6-kill9-artifact', sleepMs: 400 });
  const run = await api.waitForRunTerminal(started.run_id, 20_000);
  assert.equal(run?.status, 'done');
  const artifactId = `${started.run_id}:raw`;

  const detailBefore = await fetch(`${api.baseUrl}/artifacts/${encodeURIComponent(artifactId)}`);
  assert.equal(detailBefore.status, 200);
  const downloadBefore = await fetch(`${api.baseUrl}/artifacts/${encodeURIComponent(artifactId)}/download`);
  assert.equal(downloadBefore.status, 200);

  await api.kill('SIGKILL');
  api = await startApiProcess({
    port: api.port,
    env: {
      JEJAKEKAL_BUNDLES_ROOT: bundlesRoot
    }
  });
  const resumedApi = api;
  t.after(async () => {
    await resumedApi.stop();
  });
  await api.waitForHealth();

  const detailAfter = await fetch(`${api.baseUrl}/artifacts/${encodeURIComponent(artifactId)}`);
  assert.equal(detailAfter.status, 200);
  const downloadAfter = await fetch(`${api.baseUrl}/artifacts/${encodeURIComponent(artifactId)}/download`);
  assert.equal(downloadAfter.status, 200);
  assert.equal((await downloadAfter.text()).includes('c6-kill9-artifact'), true);
});

test('C4 retry/backoff: flaky step retries via DBOS config and succeeds on third attempt', async (t) => {
  const client = await connectDbOrSkip(t);
  if (!client) return;
  await resetAppDb(client);
  const unfreeze = freezeDeterminism({ now: Date.parse('2026-02-22T00:00:00.000Z'), random: 0.25 });
  t.after(() => unfreeze());
  t.after(async () => {
    await shutdownDbosRuntime();
  });

  await ensureDbosRuntime();
  const runId = nextWorkflowId('c4-retry');
  const handle = await startFlakyRetryWorkflowRun({ workflowId: runId, failUntilAttempt: 2 });
  const result =
    /** @type {{flaky: {attempt: number}}} */ (await handle.getResult());
  assert.equal(result.flaky.attempt, 3);

  const run = await getRunProjection(client, runId);
  assert.ok(run);
  const flakySteps = run.timeline.filter((step) => step.function_name === 'flaky');
  assert.equal(flakySteps.length, 1);
  assert.deepEqual(flakySteps[0].output, { attempt: 3 });
});

test('C4 CLI/API parity: dbos workflow get/steps matches /runs projection semantics', async (t) => {
  if (!(await setupDbOrSkip(t))) return;
  const unfreeze = freezeDeterminism({ now: Date.parse('2026-02-22T00:00:00.000Z'), random: 0.25 });
  t.after(() => unfreeze());

  const api = await startApiProcess();
  t.after(async () => {
    await api.stop();
  });
  await api.waitForHealth();

  const started = await postRun(api.baseUrl, { source: 'c4-cli-parity', sleepMs: 20 });
  const run = await api.waitForRunTerminal(started.run_id, 20_000);
  assert.equal(run?.status, 'done');

  const cliGet = await runDbosCli('get', started.run_id);
  const cliSteps = await runDbosCli('steps', started.run_id);
  assert.equal(cliGet.workflowID, run.run_id);
  assert.equal(cliGet.status, run.dbos_status);
  assert.equal(cliGet.workflowName, run.header.name);
  assert.equal(cliGet.recoveryAttempts, run.header.recovery_attempts);

  assert.deepEqual(
    cliSteps.map((step) => ({
      function_id: step.functionID,
      function_name: step.name
    })),
    run.timeline.map((step) => ({
      function_id: step.function_id,
      function_name: step.function_name
    }))
  );
});

test('C4 resume endpoint resumes CANCELLED run without duplicating completed steps', async (t) => {
  if (!(await setupDbOrSkip(t))) return;
  const unfreeze = freezeDeterminism({ now: Date.parse('2026-02-22T00:00:00.000Z'), random: 0.25 });
  t.after(() => unfreeze());

  const api = await startApiProcess();
  t.after(async () => {
    await api.stop();
  });
  await api.waitForHealth();

  const started = await postRun(api.baseUrl, { source: 'c4-manual-resume', sleepMs: 2000 });
  const runId = started.run_id;
  await waitForCondition(
    async () => {
      const run = await api.readRun(runId);
      return !!run && run.status === 'running';
    },
    { timeoutMs: 10_000, intervalMs: 50, label: `running state for ${runId}` }
  );

  await runDbosCliNoOutput('cancel', runId);
  await waitForCondition(
    async () => {
      const run = await api.readRun(runId);
      return !!run && run.dbos_status === 'CANCELLED';
    },
    { timeoutMs: 10_000, intervalMs: 100, label: `cancelled state for ${runId}` }
  );

  const resumeRes = await fetch(`${api.baseUrl}/runs/${encodeURIComponent(runId)}/resume`, {
    method: 'POST'
  });
  assert.equal(resumeRes.status, 202);
  assert.deepEqual(await resumeRes.json(), { run_id: runId, status: 'running' });

  const done = await api.waitForRunTerminal(runId, 20_000);
  assert.equal(done?.status, 'done');
  assert.equal(done?.dbos_status, 'SUCCESS');
  assert.equal(done.timeline.filter((step) => step.function_name === 'reserve-doc').length, 1);
});

test('C4 replay: cancel between S4/S5 then resume without duplicate block rows and with indexed FTS state', async (t) => {
  const client = await setupDbOrSkip(t);
  if (!client) return;
  const unfreeze = freezeDeterminism({ now: Date.parse('2026-02-22T00:00:00.000Z'), random: 0.25 });
  t.after(() => unfreeze());

  const api = await startApiProcess({
    env: {
      JEJAKEKAL_PAUSE_AFTER_S4_MS: '3000'
    }
  });
  t.after(async () => {
    await api.stop();
  });
  await api.waitForHealth();

  const started = await postRun(api.baseUrl, { source: 'invoice alpha\ninvoice beta', sleepMs: 10 });
  const runId = started.run_id;
  await waitForCondition(
    async () => {
      const run = await api.readRun(runId);
      if (!run) return false;
      return run.timeline.some((step) => step.function_name === 'normalize-docir');
    },
    { timeoutMs: 10_000, intervalMs: 50, label: `normalize-docir row for ${runId}` }
  );

  await runDbosCliNoOutput('cancel', runId);
  await waitForCondition(
    async () => {
      const run = await api.readRun(runId);
      return !!run && run.dbos_status === 'CANCELLED';
    },
    { timeoutMs: 10_000, intervalMs: 100, label: `cancelled state for ${runId}` }
  );

  const before = await client.query(
    `SELECT doc_id, ver, count(*)::int AS n, count(distinct block_id)::int AS distinct_n,
            count(*) FILTER (WHERE tsv IS NOT NULL)::int AS indexed_n
     FROM block
     GROUP BY doc_id, ver
     ORDER BY ver DESC
     LIMIT 1`
  );
  assert.equal(before.rows.length, 1);
  assert.equal(before.rows[0].n, before.rows[0].distinct_n);
  assert.equal(before.rows[0].indexed_n, 0);
  const beforeCount = before.rows[0].n;

  const resumeRes = await fetch(`${api.baseUrl}/runs/${encodeURIComponent(runId)}/resume`, { method: 'POST' });
  assert.equal(resumeRes.status, 202);
  const done = await api.waitForRunTerminal(runId, 20_000);
  assert.equal(done?.status, 'done');
  assert.equal(done?.dbos_status, 'SUCCESS');

  const after = await client.query(
    `SELECT count(*)::int AS n, count(distinct block_id)::int AS distinct_n,
            count(*) FILTER (WHERE tsv IS NOT NULL)::int AS indexed_n
     FROM block
     WHERE doc_id = $1 AND ver = $2`,
    [before.rows[0].doc_id, before.rows[0].ver]
  );
  assert.equal(after.rows[0].n, beforeCount);
  assert.equal(after.rows[0].n, after.rows[0].distinct_n);
  assert.equal(after.rows[0].indexed_n, beforeCount);
});

test('C5 replay: cancel after OCR step then resume without duplicate per-page OCR effects', async (t) => {
  const client = await setupDbOrSkip(t);
  if (!client) return;
  const unfreeze = freezeDeterminism({ now: Date.parse('2026-02-24T00:00:00.000Z'), random: 0.25 });
  const ocr = await startMockOcrServer();
  t.after(async () => {
    unfreeze();
    await ocr.close();
  });

  const api = await startApiProcess({
    env: {
      OCR_ENABLED: '1',
      OCR_ENGINE: 'vllm',
      OCR_MODEL: 'zai-org/GLM-OCR',
      OCR_BASE_URL: ocr.baseUrl,
      OCR_TIMEOUT_MS: '5000',
      OCR_MAX_PAGES: '10',
      JEJAKEKAL_PAUSE_AFTER_S4_MS: '3000'
    }
  });
  t.after(async () => {
    await api.stop();
  });
  await api.waitForHealth();

  const started = await postRun(api.baseUrl, {
    intent: 'doc',
    args: {
      source: ['scan', 'small', 'table|x', `nonce:${process.pid}-${Date.now()}`].join('\n'),
      locator: `s3://fixtures/invoice-${process.pid}-${Date.now()}.pdf`,
      mime: 'application/pdf'
    },
    sleepMs: 1
  });
  const runId = started.run_id;
  await waitForCondition(
    async () => {
      const run = await api.readRun(runId);
      if (!run) return false;
      return run.timeline.some((step) => step.function_name === 'ocr-pages');
    },
    { timeoutMs: 30_000, intervalMs: 100, label: `ocr-pages step for ${runId}` }
  );

  await runDbosCliNoOutput('cancel', runId);
  await waitForCondition(
    async () => {
      const run = await api.readRun(runId);
      return !!run && run.dbos_status === 'CANCELLED';
    },
    { timeoutMs: 10_000, intervalMs: 100, label: `cancelled state for ${runId}` }
  );

  const beforeEffects = await client.query(
    `SELECT COUNT(*)::int AS n
     FROM side_effects
     WHERE effect_key LIKE $1`,
    [`${runId}|ocr-page|%`]
  );
  assert.equal(beforeEffects.rows[0].n >= 1, true);

  const resumeRes = await fetch(`${api.baseUrl}/runs/${encodeURIComponent(runId)}/resume`, { method: 'POST' });
  assert.equal(resumeRes.status, 202);
  const done = await api.waitForRunTerminal(runId, 20_000);
  assert.equal(done?.status, 'done');
  assert.equal(done?.dbos_status, 'SUCCESS');
  assert.equal(done.timeline.filter((step) => step.function_name === 'ocr-pages').length, 1);

  const afterEffects = await client.query(
    `SELECT COUNT(*)::int AS n, COUNT(DISTINCT effect_key)::int AS distinct_n
     FROM side_effects
     WHERE effect_key LIKE $1`,
    [`${runId}|ocr-page|%`]
  );
  assert.equal(afterEffects.rows[0].n, beforeEffects.rows[0].n);
  assert.equal(afterEffects.rows[0].n, afterEffects.rows[0].distinct_n);

  const pages = await client.query(
    `SELECT COUNT(*)::int AS n
     FROM ocr_page
     WHERE job_id = $1 AND status = 'ocr_ready'`,
    [runId]
  );
  assert.equal(afterEffects.rows[0].n, pages.rows[0].n);
});

test('C4 determinism guard: default workflow body keeps nondeterminism out of workflow function', async () => {
  const source = await readFile(new URL('../src/dbos-workflows.mjs', import.meta.url), 'utf8');
  const bodyMatch = source.match(/async function defaultWorkflowImpl\(input\) \{[\s\S]*?\n\}/);
  assert.ok(bodyMatch);
  const body = bodyMatch[0];
  assert.equal(body.includes('Date.now('), false);
  assert.equal(body.includes('Math.random('), false);
  assert.equal(source.includes('async function markerConvertStep('), true);
  assert.equal(source.includes('Date.now()'), false);
});
