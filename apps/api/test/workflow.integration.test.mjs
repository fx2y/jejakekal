import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { access } from 'node:fs/promises';
import { shutdownDbosRuntime } from '../src/dbos-runtime.mjs';
import { startApiServer } from '../src/server.mjs';
import { mapDbosStatusToApiStatus, mapOperationOutputRow, mapWorkflowStatusRow } from '../src/runs-projections.mjs';
import { defaultWorkflow, readOperationOutputs, readWorkflowStatus } from '../src/workflow.mjs';
import { setupDbOrSkip } from './helpers.mjs';
import { freezeDeterminism } from '../../../packages/core/src/determinism.mjs';
import { readBundle } from '../../../packages/core/src/run-bundle.mjs';

/**
 * @param {{port:number, method:string, path:string, body?:string}} req
 */
function rawHttp(req) {
  return new Promise((resolve, reject) => {
    const pending = httpRequest(
      {
        host: '127.0.0.1',
        port: req.port,
        method: req.method,
        path: req.path,
        headers: req.body
          ? {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(req.body)
            }
          : undefined
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            json: body ? JSON.parse(body) : {}
          });
        });
      }
    );
    pending.on('error', reject);
    if (req.body) {
      pending.write(req.body);
    }
    pending.end();
  });
}

test('C1 smoke: DBOS run writes dbos.workflow_status + dbos.operation_outputs', async (t) => {
  const client = await setupDbOrSkip(t);
  if (!client) return;
  const unfreeze = freezeDeterminism({ now: Date.parse('2026-02-22T00:00:00.000Z'), random: 0.25 });
  t.after(() => unfreeze());
  t.after(async () => {
    await shutdownDbosRuntime();
  });

  const workflowId = `wf-${process.pid}-${Date.now()}`;
  const timeline = await defaultWorkflow({ client, workflowId, value: 'abc' });

  assert.ok(timeline.length >= 3);
  assert.ok(timeline.some((row) => row.step === 'prepare'));
  assert.ok(timeline.some((row) => row.step === 'side-effect'));
  assert.ok(timeline.some((row) => row.step === 'finalize'));

  const header = await readWorkflowStatus(client, workflowId);
  assert.equal(header?.workflow_uuid, workflowId);
  assert.equal(header?.status, 'SUCCESS');

  const outputs = await readOperationOutputs(client, workflowId);
  assert.ok(outputs.length >= 3);
  assert.deepEqual(
    outputs.map((row) => row.function_id),
    [...outputs.map((row) => row.function_id)].sort((a, b) => a - b)
  );
  assert.ok(outputs.every((row) => row.function_id >= 0));
});

test('C2 projection mappers normalize DBOS row shapes deterministically', () => {
  const header = mapWorkflowStatusRow({
    workflow_uuid: 'rid-1',
    status: 'SUCCESS',
    name: 'defaultWorkflow',
    created_at: '2026-02-22T00:00:00.000Z',
    updated_at: '2026-02-22T00:00:01.000Z',
    recovery_attempts: '2',
    executor_id: 'exec-1'
  });
  assert.equal(header.workflow_uuid, 'rid-1');
  assert.equal(header.recovery_attempts, 2);

  const step = mapOperationOutputRow({
    workflow_uuid: 'rid-1',
    function_id: '3',
    function_name: 'finalize',
    started_at_epoch_ms: '100',
    completed_at_epoch_ms: '200',
    output: JSON.stringify({ json: { ok: true } }),
    error: null
  });
  assert.equal(step.function_id, 3);
  assert.equal(step.started_at_epoch_ms, 100);
  assert.deepEqual(step.output, { ok: true });

  assert.equal(mapDbosStatusToApiStatus('SUCCESS'), 'done');
  assert.equal(mapDbosStatusToApiStatus('RUNNING'), 'running');
  assert.equal(mapDbosStatusToApiStatus('NEW_UNKNOWN_STATUS'), 'unknown');
});

test('C2 canonical /runs is durable-start async and GET /runs/:id projects ordered timeline', async (t) => {
  const client = await setupDbOrSkip(t);
  if (!client) return;
  const unfreeze = freezeDeterminism({ now: Date.parse('2026-02-22T00:00:00.000Z'), random: 0.25 });
  t.after(() => unfreeze());

  const api = await startApiServer(0);
  t.after(async () => {
    await api.close();
  });

  const baseUrl = `http://127.0.0.1:${api.port}`;
  const startRes = await fetch(`${baseUrl}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'c2-http', sleepMs: 500 })
  });
  assert.equal(startRes.status, 202);
  const started = await startRes.json();
  assert.equal(typeof started.run_id, 'string');
  assert.ok(started.run_id.length > 0);
  assert.ok(!started.run_id.startsWith('wf-'));

  const firstGet = await fetch(`${baseUrl}/runs/${encodeURIComponent(started.run_id)}`);
  assert.equal(firstGet.status, 200);
  const firstRun = await firstGet.json();
  assert.equal(firstRun.run_id, started.run_id);
  assert.notEqual(firstRun.status, 'done');
  assert.notEqual(firstRun.dbos_status, 'SUCCESS');

  let run = firstRun;
  for (let i = 0; i < 80 && run.status !== 'done'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const pollRes = await fetch(`${baseUrl}/runs/${encodeURIComponent(started.run_id)}`);
    assert.equal(pollRes.status, 200);
    run = await pollRes.json();
  }

  assert.equal(run.status, 'done');
  assert.equal(run.dbos_status, 'SUCCESS');
  assert.equal(run.header.workflow_uuid, started.run_id);
  assert.ok(Array.isArray(run.timeline));
  assert.ok(run.timeline.length >= 3);
  assert.deepEqual(
    run.timeline.map((row) => row.function_id),
    [...run.timeline.map((row) => row.function_id)].sort((a, b) => a - b)
  );
  assert.ok(run.timeline.some((row) => row.function_name === 'prepare'));
  assert.ok(run.timeline.some((row) => row.function_name === 'side-effect'));
  assert.ok(run.timeline.some((row) => row.function_name === 'finalize'));
});

test('C3 export endpoint writes additive DBOS snapshot bundle for offline reconstruction', async (t) => {
  const client = await setupDbOrSkip(t);
  if (!client) return;
  const unfreeze = freezeDeterminism({ now: Date.parse('2026-02-22T00:00:00.000Z'), random: 0.25 });
  t.after(() => unfreeze());

  const api = await startApiServer(0);
  t.after(async () => {
    await api.close();
  });

  const baseUrl = `http://127.0.0.1:${api.port}`;
  const source = 'alpha\nbeta [low]\ngamma';
  const startRes = await fetch(`${baseUrl}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source, sleepMs: 10 })
  });
  assert.equal(startRes.status, 202);
  const started = await startRes.json();

  /** @type {any} */
  let run = null;
  for (let i = 0; i < 80; i += 1) {
    const pollRes = await fetch(`${baseUrl}/runs/${encodeURIComponent(started.run_id)}`);
    assert.equal(pollRes.status, 200);
    run = await pollRes.json();
    if (run.status === 'done') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(run?.status, 'done');

  const exportRes = await fetch(`${baseUrl}/runs/${encodeURIComponent(started.run_id)}/export`);
  assert.equal(exportRes.status, 200);
  const exported = await exportRes.json();
  assert.equal(exported.run_id, started.run_id);
  assert.equal(typeof exported.run_bundle_path, 'string');
  assert.deepEqual(
    exported.artifacts.map((row) => row.id),
    ['raw', 'docir', 'chunk-index', 'memo']
  );

  const bundle = await readBundle(exported.run_bundle_path);
  assert.ok(bundle['workflow_status.json']);
  assert.ok(bundle['operation_outputs.json']);
  assert.equal(bundle['manifest.json'].root, '<run-bundle-root>');

  assert.equal(bundle['workflow_status.json'].workflow_uuid, started.run_id);
  assert.equal(bundle['workflow_status.json'].status, 'SUCCESS');
  assert.deepEqual(
    bundle['operation_outputs.json'].map((row) => row.function_id),
    run.timeline.map((row) => row.function_id)
  );
  assert.equal(bundle['operation_outputs.json'][0].output.source, source);
});

test('P0 malformed JSON on POST /runs returns 400 invalid_json', async (t) => {
  const client = await setupDbOrSkip(t);
  if (!client) return;
  const api = await startApiServer(0);
  t.after(async () => {
    await api.close();
  });

  const baseUrl = `http://127.0.0.1:${api.port}`;
  const badRes = await fetch(`${baseUrl}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{'
  });
  assert.equal(badRes.status, 400);
  assert.deepEqual(await badRes.json(), { error: 'invalid_json' });
});

test('P0 run-id validation rejects path traversal and encoded dot-segments', async (t) => {
  const client = await setupDbOrSkip(t);
  if (!client) return;
  const api = await startApiServer(0);
  t.after(async () => {
    await api.close();
  });

  const baseUrl = `http://127.0.0.1:${api.port}`;

  const badStart = await fetch(`${baseUrl}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'x', workflowId: '../x' })
  });
  assert.equal(badStart.status, 400);
  assert.deepEqual(await badStart.json(), { error: 'invalid_run_id', field: 'workflowId' });

  const badRun = await rawHttp({ port: api.port, method: 'GET', path: '/runs/%2E%2E' });
  assert.equal(badRun.status, 400);
  assert.deepEqual(badRun.json, { error: 'invalid_run_id', field: 'run_id' });

  const badExport = await rawHttp({ port: api.port, method: 'GET', path: '/runs/..%2Fx/export' });
  assert.equal(badExport.status, 400);
  assert.deepEqual(badExport.json, { error: 'invalid_run_id', field: 'run_id' });
});

test('P0 workflowId dedup rejects payload mismatch with 409', async (t) => {
  const client = await setupDbOrSkip(t);
  if (!client) return;
  const api = await startApiServer(0);
  t.after(async () => {
    await api.close();
  });

  const baseUrl = `http://127.0.0.1:${api.port}`;
  const workflowId = `wf-dedup-${process.pid}-${Date.now()}`;

  const first = await fetch(`${baseUrl}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'same-id-one', workflowId, sleepMs: 5 })
  });
  assert.equal(first.status, 202);

  const second = await fetch(`${baseUrl}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'same-id-two', workflowId, sleepMs: 5 })
  });
  assert.equal(second.status, 409);
  assert.deepEqual(await second.json(), {
    error: 'workflow_id_payload_mismatch',
    workflow_id: workflowId
  });
});

test('P1 export fails with 422 when source cannot be recovered from timeline', async (t) => {
  const client = await setupDbOrSkip(t);
  if (!client) return;
  const api = await startApiServer(0);
  t.after(async () => {
    await api.close();
  });

  const baseUrl = `http://127.0.0.1:${api.port}`;
  const startRes = await fetch(`${baseUrl}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'will-be-removed', sleepMs: 10 })
  });
  assert.equal(startRes.status, 202);
  const started = await startRes.json();

  /** @type {any} */
  let run = null;
  for (let i = 0; i < 80; i += 1) {
    const pollRes = await fetch(`${baseUrl}/runs/${encodeURIComponent(started.run_id)}`);
    assert.equal(pollRes.status, 200);
    run = await pollRes.json();
    if (run.status === 'done') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(run?.status, 'done');

  await client.query(
    `UPDATE dbos.operation_outputs
     SET output = $2
     WHERE workflow_uuid = $1 AND function_name = 'prepare'`,
    [started.run_id, JSON.stringify({ json: { prepared: 'MISSING_SOURCE' } })]
  );

  const exportRes = await fetch(`${baseUrl}/runs/${encodeURIComponent(started.run_id)}/export`);
  assert.equal(exportRes.status, 422);
  assert.deepEqual(await exportRes.json(), {
    error: 'source_unrecoverable',
    run_id: started.run_id
  });
});

test('P2 api close removes temporary bundles root by default', async (t) => {
  const client = await setupDbOrSkip(t);
  if (!client) return;

  const api = await startApiServer(0);
  const bundlesRoot = api.bundlesRoot;
  await access(bundlesRoot);
  await api.close();

  await assert.rejects(() => access(bundlesRoot));
});
