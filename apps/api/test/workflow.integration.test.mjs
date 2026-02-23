import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shutdownDbosRuntime } from '../src/dbos-runtime.mjs';
import { startApiServer } from '../src/server.mjs';
import { mapDbosStatusToApiStatus, mapOperationOutputRow, mapWorkflowStatusRow } from '../src/runs-projections.mjs';
import { defaultWorkflow, readOperationOutputs, readWorkflowStatus } from '../src/workflow.mjs';
import { setupDbOrSkip } from './helpers.mjs';
import { freezeDeterminism } from '../../../packages/core/src/determinism.mjs';
import { readBundle } from '../../../packages/core/src/run-bundle.mjs';
import { sha256 } from '../../../packages/core/src/hash.mjs';
import { listZipEntries } from '../../../packages/core/src/deterministic-zip.mjs';
import { parseArtifactUri } from '../src/artifact-uri.mjs';
import { createS3BlobStore, defaultS3BlobStoreConfig } from '../src/blob/s3-store.mjs';

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

async function waitForRunTerminal(baseUrl, runId, attempts = 80, delayMs = 25) {
  /** @type {any} */
  let run = null;
  for (let i = 0; i < attempts; i += 1) {
    const pollRes = await fetch(`${baseUrl}/runs/${encodeURIComponent(runId)}`);
    assert.equal(pollRes.status, 200);
    run = await pollRes.json();
    if (run.status === 'done' || run.status === 'error') break;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return run;
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
  assert.ok(timeline.some((row) => row.step === 'reserve-doc'));
  assert.ok(timeline.some((row) => row.step === 'store-raw'));
  assert.ok(timeline.some((row) => row.step === 'marker-convert'));
  assert.ok(timeline.some((row) => row.step === 'store-parse-outputs'));
  assert.ok(timeline.some((row) => row.step === 'artifact-count'));

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

test('C1 artifact core: successful run persists immutable quartet rows', async (t) => {
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
    body: JSON.stringify({ source: 'artifact-core-c1', sleepMs: 10 })
  });
  assert.equal(startRes.status, 202);
  const started = await startRes.json();

  let run = null;
  for (let i = 0; i < 80; i += 1) {
    const pollRes = await fetch(`${baseUrl}/runs/${encodeURIComponent(started.run_id)}`);
    assert.equal(pollRes.status, 200);
    run = await pollRes.json();
    if (run.status === 'done') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(run?.status, 'done');

  const artifacts = await client.query(
    `SELECT id, type, prov
     FROM artifact
     WHERE run_id = $1
     ORDER BY type ASC`,
    [started.run_id]
  );
  assert.equal(artifacts.rows.length, 4);
  assert.deepEqual(
    artifacts.rows.map((row) => row.type),
    ['chunk-index', 'docir', 'memo', 'raw']
  );
  for (const row of artifacts.rows) {
    assert.equal(row.id, `${started.run_id}:${row.type}`);
    assert.equal(typeof row.prov.hash.artifact_sha256, 'string');
    assert.equal(typeof row.prov.hash.source_sha256, 'string');
    assert.equal(row.prov.run_id, started.run_id);
    assert.equal(row.prov.artifact_type, row.type);
    assert.equal(typeof row.prov.source, 'undefined');
    assert.equal(typeof row.prov.content, 'undefined');
  }

  await assert.rejects(
    () => client.query('UPDATE artifact SET title = $2 WHERE id = $1', [`${started.run_id}:raw`, 'mutate']),
    /artifact_immutable/
  );
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
  assert.equal(step.duration_ms, 100);
  assert.equal(step.attempt, 1);
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
    body: JSON.stringify({ intent: 'doc', args: { source: 'c2-http' }, sleepMs: 500 })
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
  assert.ok(run.timeline.some((row) => row.function_name === 'reserve-doc'));
  assert.ok(run.timeline.some((row) => row.function_name === 'store-raw'));
  assert.ok(run.timeline.some((row) => row.function_name === 'marker-convert'));
  assert.ok(run.timeline.some((row) => row.function_name === 'store-parse-outputs'));
  assert.ok(run.timeline.every((row) => typeof row.attempt === 'number'));
  assert.ok(run.timeline.some((row) => Array.isArray(row.io_hashes)));
  assert.ok(Array.isArray(run.artifacts));
  assert.equal(run.artifacts.length, 4);
  assert.equal(typeof run.artifacts[0].prov, 'object');

  const rawArtifactRow = await client.query(
    `SELECT id, type, uri, sha256
     FROM artifact
     WHERE run_id = $1 AND type = 'raw'`,
    [started.run_id]
  );
  assert.equal(rawArtifactRow.rows.length, 1);
  assert.equal(rawArtifactRow.rows[0].id, `${started.run_id}:raw`);
  assert.equal(typeof rawArtifactRow.rows[0].sha256, 'string');
  assert.equal(rawArtifactRow.rows[0].uri.startsWith('s3://mem/raw/sha256/'), true);

  const docRows = await client.query(
    `SELECT d.doc_id, d.raw_sha, d.latest_ver, dv.ver
     FROM doc d
     JOIN doc_ver dv ON dv.doc_id = d.doc_id
     WHERE d.raw_sha = $1
     ORDER BY dv.ver ASC`,
    [rawArtifactRow.rows[0].sha256]
  );
  assert.equal(docRows.rows.length, 1);
  assert.equal(docRows.rows[0].latest_ver, 1);
  assert.equal(docRows.rows[0].ver, 1);
  assert.equal(typeof docRows.rows[0].doc_id, 'string');
});

test('C2 payload guards: no default source fallback and invalid command typed 400', async (t) => {
  const client = await setupDbOrSkip(t);
  if (!client) return;
  const api = await startApiServer(0);
  t.after(async () => {
    await api.close();
  });

  const baseUrl = `http://127.0.0.1:${api.port}`;
  const missingPayload = await fetch(`${baseUrl}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.equal(missingPayload.status, 400);
  assert.deepEqual(await missingPayload.json(), { error: 'invalid_run_payload' });

  const unknownCommand = await fetch(`${baseUrl}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd: '/nope abc' })
  });
  assert.equal(unknownCommand.status, 400);
  assert.deepEqual(await unknownCommand.json(), { error: 'invalid_command', cmd: '/nope' });

  const badSleepType = await fetch(`${baseUrl}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'x', sleepMs: 'abc' })
  });
  assert.equal(badSleepType.status, 400);
  assert.deepEqual(await badSleepType.json(), { error: 'invalid_run_payload' });

  const badSleepZero = await fetch(`${baseUrl}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'x', sleepMs: 0 })
  });
  assert.equal(badSleepZero.status, 400);
  assert.deepEqual(await badSleepZero.json(), { error: 'invalid_run_payload' });
});

test('C2 chat ledger invariant: POST /runs writes cmd,args,run_id only', async (t) => {
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
    body: JSON.stringify({ cmd: '/doc chat-ledger-c2', sleepMs: 10 })
  });
  assert.equal(startRes.status, 202);
  const started = await startRes.json();
  assert.equal(typeof started.run_id, 'string');

  const rows = await client.query(
    `SELECT cmd, args, run_id, created_at
     FROM chat_event
     WHERE run_id = $1`,
    [started.run_id]
  );
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].cmd, '/doc');
  assert.deepEqual(rows.rows[0].args, { source: 'chat-ledger-c2' });
  assert.equal(rows.rows[0].run_id, started.run_id);
  assert.ok(rows.rows[0].created_at);
  assert.equal(Object.hasOwn(rows.rows[0], 'answer'), false);

  const leakCount = await client.query(
    `SELECT count(*)::int AS n
     FROM chat_event
     WHERE args ? 'assistantAnswer'`
  );
  assert.equal(leakCount.rows[0].n, 0);
});

test('C2 artifact routes: list/detail/download and typed id errors', async (t) => {
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
    body: JSON.stringify({ intent: 'doc', args: { source: 'artifact-route-c2' }, sleepMs: 10 })
  });
  assert.equal(startRes.status, 202);
  const started = await startRes.json();
  const run = await waitForRunTerminal(baseUrl, started.run_id);
  assert.equal(run?.status, 'done');

  const listRes = await fetch(`${baseUrl}/artifacts?type=raw&visibility=user`);
  assert.equal(listRes.status, 200);
  const listed = await listRes.json();
  assert.equal(Array.isArray(listed), true);
  assert.equal(listed.length >= 1, true);
  assert.equal(listed[0].type, 'raw');
  assert.equal(listed[0].run_id, started.run_id);

  const artifactId = `${started.run_id}:raw`;
  const detailRes = await fetch(`${baseUrl}/artifacts/${encodeURIComponent(artifactId)}`);
  assert.equal(detailRes.status, 200);
  const detail = await detailRes.json();
  assert.equal(detail.meta.id, artifactId);
  assert.equal(detail.meta.type, 'raw');
  assert.equal(typeof detail.content, 'string');
  assert.equal(detail.content.includes('artifact-route-c2'), true);
  assert.equal(detail.prov.run_id, started.run_id);

  const downloadRes = await fetch(`${baseUrl}/artifacts/${encodeURIComponent(artifactId)}/download`);
  assert.equal(downloadRes.status, 200);
  assert.equal(downloadRes.headers.get('content-type')?.startsWith('text/plain'), true);
  assert.equal((await downloadRes.text()).includes('artifact-route-c2'), true);

  const notFoundRes = await fetch(`${baseUrl}/artifacts/not-found`);
  assert.equal(notFoundRes.status, 404);
  assert.deepEqual(await notFoundRes.json(), { error: 'artifact_not_found', artifact_id: 'not-found' });

  const badDetail = await rawHttp({
    port: api.port,
    method: 'GET',
    path: '/artifacts/%2E%2E'
  });
  assert.equal(badDetail.status, 400);
  assert.deepEqual(badDetail.json, { error: 'invalid_artifact_id', field: 'artifact_id' });
});

test('C2 resume endpoint rejects non-resumable run states with typed conflict', async (t) => {
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
    body: JSON.stringify({ source: 'resume-guard-c2', sleepMs: 10 })
  });
  assert.equal(startRes.status, 202);
  const started = await startRes.json();
  const run = await waitForRunTerminal(baseUrl, started.run_id);
  assert.equal(run?.status, 'done');

  const resumeRes = await fetch(`${baseUrl}/runs/${encodeURIComponent(started.run_id)}/resume`, {
    method: 'POST'
  });
  assert.equal(resumeRes.status, 409);
  assert.deepEqual(await resumeRes.json(), {
    error: 'run_not_resumable',
    run_id: started.run_id
  });
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
  assert.ok(bundle['artifact_provenance.json']);
  assert.ok(Array.isArray(bundle['manifest.json'].artifact_refs));
  assert.ok(Array.isArray(bundle['manifest.json'].step_summaries));
});

test('C4 bundle endpoint is deterministic and preserves /export compatibility', async (t) => {
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
    body: JSON.stringify({ source: 'bundle-c4', sleepMs: 10 })
  });
  assert.equal(startRes.status, 202);
  const started = await startRes.json();
  const run = await waitForRunTerminal(baseUrl, started.run_id);
  assert.equal(run?.status, 'done');

  const firstBundleRes = await fetch(`${baseUrl}/runs/${encodeURIComponent(started.run_id)}/bundle`);
  assert.equal(firstBundleRes.status, 200);
  assert.equal(firstBundleRes.headers.get('content-type'), 'application/zip');
  const firstBundle = Buffer.from(await firstBundleRes.arrayBuffer());

  const secondBundleRes = await fetch(`${baseUrl}/runs/${encodeURIComponent(started.run_id)}/bundle.zip`);
  assert.equal(secondBundleRes.status, 200);
  assert.equal(secondBundleRes.headers.get('content-type'), 'application/zip');
  const secondBundle = Buffer.from(await secondBundleRes.arrayBuffer());

  assert.equal(sha256(firstBundle), sha256(secondBundle));
  assert.deepEqual(
    listZipEntries(firstBundle).map((entry) => entry.name),
    [
      'artifact_provenance.json',
      'artifacts.json',
      'citations.json',
      'manifest.json',
      'operation_outputs.json',
      'timeline.json',
      'tool-io.json',
      'workflow_status.json'
    ]
  );

  const exportRes = await fetch(`${baseUrl}/runs/${encodeURIComponent(started.run_id)}/export`);
  assert.equal(exportRes.status, 200);
  const exported = await exportRes.json();
  assert.equal(exported.run_id, started.run_id);
  assert.equal(typeof exported.run_bundle_path, 'string');
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

test('C2 doc identity: same raw source reuses doc_id and increments doc_ver', async (t) => {
  const client = await setupDbOrSkip(t);
  if (!client) return;
  const api = await startApiServer(0);
  t.after(async () => {
    await api.close();
  });

  const baseUrl = `http://127.0.0.1:${api.port}`;
  const source = 'same-doc-c2';
  const first = await fetch(`${baseUrl}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source, sleepMs: 10 })
  });
  assert.equal(first.status, 202);
  const firstRun = await first.json();
  const second = await fetch(`${baseUrl}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source, sleepMs: 10 })
  });
  assert.equal(second.status, 202);
  const secondRun = await second.json();
  assert.notEqual(firstRun.run_id, secondRun.run_id);

  const runA = await waitForRunTerminal(baseUrl, firstRun.run_id);
  const runB = await waitForRunTerminal(baseUrl, secondRun.run_id);
  assert.equal(runA?.status, 'done');
  assert.equal(runB?.status, 'done');

  const rows = await client.query(
    `SELECT d.doc_id, d.latest_ver, dv.ver
     FROM doc d
     JOIN doc_ver dv ON dv.doc_id = d.doc_id
     ORDER BY dv.ver ASC`
  );
  assert.equal(rows.rows.length, 2);
  assert.equal(rows.rows[0].doc_id, rows.rows[1].doc_id);
  assert.equal(rows.rows[0].ver, 1);
  assert.equal(rows.rows[1].ver, 2);
  assert.equal(rows.rows[1].latest_ver, 2);
});

test('C6 chat ledger dedup: idempotent retry with same workflowId keeps one chat_event row', async (t) => {
  const client = await setupDbOrSkip(t);
  if (!client) return;
  const api = await startApiServer(0);
  t.after(async () => {
    await api.close();
  });

  const baseUrl = `http://127.0.0.1:${api.port}`;
  const workflowId = `wf-chat-dedup-${process.pid}-${Date.now()}`;
  const body = { intent: 'doc', args: { source: 'chat-dedup' }, workflowId, sleepMs: 5 };

  const first = await fetch(`${baseUrl}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  assert.equal(first.status, 202);
  const second = await fetch(`${baseUrl}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  assert.equal(second.status, 202);
  const firstBody = await first.json();
  const secondBody = await second.json();
  assert.equal(secondBody.run_id, firstBody.run_id);

  const rows = await client.query(
    `SELECT id, cmd, args, run_id
     FROM chat_event
     WHERE run_id = $1`,
    [firstBody.run_id]
  );
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].cmd, '/doc');
  assert.deepEqual(rows.rows[0].args, { source: 'chat-dedup' });
  assert.equal(rows.rows[0].run_id, firstBody.run_id);
});

test('P1 export reads persisted artifacts even when source cannot be recovered from timeline', async (t) => {
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
     WHERE workflow_uuid = $1 AND function_name = 'reserve-doc'`,
     [started.run_id, JSON.stringify({ json: { prepared: 'MISSING_SOURCE' } })]
   );

  const exportRes = await fetch(`${baseUrl}/runs/${encodeURIComponent(started.run_id)}/export`);
  assert.equal(exportRes.status, 200);
  const exported = await exportRes.json();
  assert.equal(exported.run_id, started.run_id);
  assert.deepEqual(
    exported.artifacts.map((row) => row.id),
    ['raw', 'docir', 'chunk-index', 'memo']
  );
});

test('C6 artifact blobs survive graceful API restart for detail/download', async (t) => {
  const client = await setupDbOrSkip(t);
  if (!client) return;
  const bundlesRoot = await mkdtemp(join(tmpdir(), 'jejakekal-c6-bundles-'));
  t.after(async () => {
    await rm(bundlesRoot, { recursive: true, force: true });
  });

  let api = await startApiServer(0, { bundlesRoot });
  t.after(async () => {
    await api.close();
  });
  let baseUrl = `http://127.0.0.1:${api.port}`;
  const startRes = await fetch(`${baseUrl}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'c6-graceful-restart', sleepMs: 10 })
  });
  assert.equal(startRes.status, 202);
  const started = await startRes.json();
  const run = await waitForRunTerminal(baseUrl, started.run_id);
  assert.equal(run?.status, 'done');

  const artifactId = `${started.run_id}:raw`;
  const detailBefore = await fetch(`${baseUrl}/artifacts/${encodeURIComponent(artifactId)}`);
  assert.equal(detailBefore.status, 200);
  const downloadBefore = await fetch(`${baseUrl}/artifacts/${encodeURIComponent(artifactId)}/download`);
  assert.equal(downloadBefore.status, 200);

  await api.close();
  api = await startApiServer(0, { bundlesRoot });
  baseUrl = `http://127.0.0.1:${api.port}`;

  const detailAfter = await fetch(`${baseUrl}/artifacts/${encodeURIComponent(artifactId)}`);
  assert.equal(detailAfter.status, 200);
  const detailJson = await detailAfter.json();
  assert.equal(detailJson.meta.id, artifactId);

  const downloadAfter = await fetch(`${baseUrl}/artifacts/${encodeURIComponent(artifactId)}/download`);
  assert.equal(downloadAfter.status, 200);
  assert.equal((await downloadAfter.text()).includes('c6-graceful-restart'), true);
});

test('C6 export and bundle fail closed when persisted artifact blob is missing', async (t) => {
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
    body: JSON.stringify({ source: 'c6-dangling-blob', sleepMs: 10 })
  });
  assert.equal(startRes.status, 202);
  const started = await startRes.json();
  const run = await waitForRunTerminal(baseUrl, started.run_id);
  assert.equal(run?.status, 'done');

  const rowRes = await client.query(`SELECT id, uri FROM artifact WHERE run_id = $1 AND type = 'docir'`, [started.run_id]);
  assert.equal(rowRes.rows.length, 1);
  const artifactId = rowRes.rows[0].id;
  const parsed = parseArtifactUri(rowRes.rows[0].uri);
  assert.equal(parsed.scheme, 's3');
  const s3Store = createS3BlobStore(defaultS3BlobStoreConfig());
  await s3Store.deleteObject({ bucket: parsed.bucket, key: parsed.key });

  const detailRes = await fetch(`${baseUrl}/artifacts/${encodeURIComponent(artifactId)}`);
  assert.equal(detailRes.status, 500);
  assert.deepEqual(await detailRes.json(), { error: 'internal_error' });

  const exportRes = await fetch(`${baseUrl}/runs/${encodeURIComponent(started.run_id)}/export`);
  assert.equal(exportRes.status, 500);
  assert.deepEqual(await exportRes.json(), { error: 'internal_error' });

  const bundleRes = await fetch(`${baseUrl}/runs/${encodeURIComponent(started.run_id)}/bundle`);
  assert.equal(bundleRes.status, 500);
  assert.deepEqual(await bundleRes.json(), { error: 'internal_error' });
});

test('C6 artifact detail fails closed for tampered JSON blob', async (t) => {
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
    body: JSON.stringify({ source: 'c6-corrupt-json', sleepMs: 10 })
  });
  assert.equal(startRes.status, 202);
  const started = await startRes.json();
  const run = await waitForRunTerminal(baseUrl, started.run_id);
  assert.equal(run?.status, 'done');

  const rowRes = await client.query(`SELECT id, uri FROM artifact WHERE run_id = $1 AND type = 'docir'`, [started.run_id]);
  assert.equal(rowRes.rows.length, 1);
  const artifactId = rowRes.rows[0].id;
  const parsed = parseArtifactUri(rowRes.rows[0].uri);
  assert.equal(parsed.scheme, 's3');
  const s3Store = createS3BlobStore(defaultS3BlobStoreConfig());
  await s3Store.putObjectChecked({
    key: parsed.key,
    payload: Buffer.from('{bad json', 'utf8'),
    contentType: 'application/json'
  });

  const detailRes = await fetch(`${baseUrl}/artifacts/${encodeURIComponent(artifactId)}`);
  assert.equal(detailRes.status, 500);
  assert.deepEqual(await detailRes.json(), { error: 'internal_error' });
});

test('C6 api close keeps default bundles root; explicit cleanup remains available', async (t) => {
  const client = await setupDbOrSkip(t);
  if (!client) return;

  const api = await startApiServer(0);
  const bundlesRoot = api.bundlesRoot;
  await access(bundlesRoot);
  await api.close();
  await access(bundlesRoot);

  const cleanupRoot = await mkdtemp(join(tmpdir(), 'jejakekal-c6-cleanup-'));
  const cleanupApi = await startApiServer(0, { bundlesRoot: cleanupRoot, cleanupBundlesOnClose: true });
  await access(cleanupRoot);
  await cleanupApi.close();
  await assert.rejects(() => access(cleanupRoot));
});
