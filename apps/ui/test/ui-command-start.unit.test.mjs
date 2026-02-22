import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRunAfterStart, runSeedFromStartResponse } from '../src/ui-command-start.mjs';

test('ui-command-start: seeds minimal run from start response', () => {
  assert.deepEqual(
    runSeedFromStartResponse({ run_id: 'r1', status: 'running', dbos_status: null }),
    { run_id: 'r1', status: 'running', dbos_status: null }
  );
});

test('ui-command-start: falls back to start seed when first run read fails', async () => {
  const run = await resolveRunAfterStart(
    { ok: true, body: { run_id: 'r-seed', status: 'running', dbos_status: null } },
    async () => ({ ok: false, status: 404, body: { error: 'run_not_found' } })
  );
  assert.deepEqual(run, { run_id: 'r-seed', status: 'running', dbos_status: null });
});

test('ui-command-start: prefers hydrated run projection when available', async () => {
  const run = await resolveRunAfterStart(
    { ok: true, body: { run_id: 'r2', status: 'running' } },
    async (runId) => ({
      ok: true,
      status: 200,
      body: { run_id: runId, status: 'done', dbos_status: 'SUCCESS', timeline: [] }
    })
  );
  assert.equal(run?.status, 'done');
  assert.equal(run?.dbos_status, 'SUCCESS');
});
