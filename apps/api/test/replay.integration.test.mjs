import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureDbosRuntime, shutdownDbosRuntime } from '../src/dbos-runtime.mjs';
import { startFlakyRetryWorkflowRun } from '../src/dbos-workflows.mjs';
import { getRunProjection } from '../src/runs-projections.mjs';
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
      return run.timeline.some((step) => step.function_name === 'prepare');
    },
    { timeoutMs: 10_000, intervalMs: 50, label: `prepare row for ${runId}` }
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
  assert.equal(steps.filter((step) => step.function_name === 'prepare').length, 1);
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

  const done = await api.waitForRunTerminal(runId, 20_000);
  assert.equal(done?.status, 'done');
  assert.equal(done?.dbos_status, 'SUCCESS');
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
  assert.equal(done.timeline.filter((step) => step.function_name === 'prepare').length, 1);
});

test('C4 determinism guard: default workflow body keeps nondeterminism out of workflow function', async () => {
  const source = await readFile(new URL('../src/dbos-workflows.mjs', import.meta.url), 'utf8');
  const bodyMatch = source.match(/async function defaultWorkflowImpl\(input\) \{[\s\S]*?\n\}/);
  assert.ok(bodyMatch);
  const body = bodyMatch[0];
  assert.equal(body.includes('Date.now('), false);
  assert.equal(body.includes('Math.random('), false);
  assert.equal(source.includes('async function sideEffectStep()'), true);
  assert.equal(source.includes('Date.now()'), true);
});
