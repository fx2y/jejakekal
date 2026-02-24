import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shutdownDbosRuntime } from '../src/dbos-runtime.mjs';
import { startApiServer } from '../src/server.mjs';
import { mapDbosStatusToApiStatus, mapOperationOutputRow, mapWorkflowStatusRow } from '../src/runs-projections.mjs';
import { defaultWorkflow, hardDocWorkflow, readOperationOutputs, readWorkflowStatus } from '../src/workflow.mjs';
import { setupDbOrSkip } from './helpers.mjs';
import { freezeDeterminism } from '../../../packages/core/src/determinism.mjs';
import { readBundle } from '../../../packages/core/src/run-bundle.mjs';
import { sha256 } from '../../../packages/core/src/hash.mjs';
import { listZipEntries } from '../../../packages/core/src/deterministic-zip.mjs';
import { parseArtifactUri } from '../src/artifact-uri.mjs';
import { createS3BlobStore, defaultS3BlobStoreConfig } from '../src/blob/s3-store.mjs';
import { queryRankedBlocksByTsQuery } from '../src/retrieval/service.mjs';
import { closeServer, listenLocal } from '../src/http.mjs';
import { exportRunBundle } from '../src/export-run.mjs';
import { deriveHardDocWorkflowId } from '../src/runs-service.mjs';
import {
  buildLexicalHeadline,
  inspectLexicalQuery,
  populateBlockTsv,
  queryTableCellLaneRows,
  queryVectorLaneRows,
  upsertBlockLedger
} from '../src/search/block-repository.mjs';

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

async function startMockOcrServer() {
  const requests = [];
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    for await (const chunk of req) {
      body += chunk.toString();
    }
    requests.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: [{ type: 'text', text: 'ocr text' }]
            }
          }
        ]
      })
    );
  });
  const port = await listenLocal(server, 0);
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => closeServer(server)
  };
}

const BASELINE_TEXT_LANE_STEPS = Object.freeze([
  '0:reserve-doc',
  '1:store-raw',
  '2:DBOS.sleep',
  '3:marker-convert',
  '4:store-parse-outputs',
  '5:normalize-docir',
  '6:index-fts',
  '7:emit-exec-memo',
  '8:artifact-count'
]);

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

test('C0 contract freeze: baseline text lane function_id -> step mapping is unchanged', async (t) => {
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
    body: JSON.stringify({ source: 'c0-step-id-freeze', sleepMs: 10 })
  });
  assert.equal(startRes.status, 202);
  const started = await startRes.json();
  const run = await waitForRunTerminal(baseUrl, started.run_id);
  assert.equal(run.status, 'done');
  const lane = run.timeline.map((row) => `${row.function_id}:${row.function_name}`);
  assert.deepEqual(lane, BASELINE_TEXT_LANE_STEPS);
});

test('C2 hard-doc branch: gate persists and rendered pages store PNG URIs/SHAs', async (t) => {
  const client = await setupDbOrSkip(t);
  if (!client) return;
  const workflowId = `hard-c1-${process.pid}-${Date.now()}`;
  const timeline = await hardDocWorkflow({
    client,
    workflowId,
    value: ['scan', 'small', 'table|x'].join('\n'),
    sleepMs: 1,
    ocrPolicy: {
      enabled: false,
      engine: 'vllm',
      model: 'zai-org/GLM-OCR',
      baseUrl: 'http://127.0.0.1:65535',
      timeoutMs: 1000,
      maxPages: 10
    }
  });
  assert.ok(timeline.some((row) => row.step === 'ocr-persist-gate'));
  assert.ok(timeline.some((row) => row.step === 'ocr-render-store-pages'));

  const jobRows = await client.query(
    `SELECT job_id, doc_id, ver, gate_rev, policy
     FROM ocr_job
     WHERE job_id = $1`,
    [workflowId]
  );
  assert.equal(jobRows.rows.length, 1);
  assert.equal(jobRows.rows[0].job_id, workflowId);
  assert.equal(typeof jobRows.rows[0].doc_id, 'string');
  assert.ok(jobRows.rows[0].ver >= 1);
  assert.equal(typeof jobRows.rows[0].gate_rev, 'string');
  assert.equal(typeof jobRows.rows[0].policy, 'object');

  const pageRows = await client.query(
    `SELECT page_idx, status, gate_score, gate_reasons, png_uri, png_sha
     FROM ocr_page
     WHERE job_id = $1
     ORDER BY page_idx ASC`,
    [workflowId]
  );
  assert.equal(pageRows.rows.length, 3);
  assert.deepEqual(
    pageRows.rows.map((row) => row.page_idx),
    [0, 1, 2]
  );
  assert.ok(pageRows.rows.some((row) => row.status === 'rendered'));
  assert.ok(
    pageRows.rows.every((row) =>
      Array.isArray(row.gate_reasons) && typeof Number(row.gate_score ?? 0) === 'number'
    )
  );
  const renderedRows = pageRows.rows.filter((row) => row.status === 'rendered');
  assert.ok(renderedRows.length >= 1);
  assert.ok(
    renderedRows.every(
      (row) =>
        typeof row.png_uri === 'string' &&
        row.png_uri.startsWith('s3://mem/run/') &&
        typeof row.png_sha === 'string' &&
        row.png_sha.length === 64
    )
  );

  const diffRows = await client.query(
    `SELECT page_idx
     FROM docir_page_diff
     WHERE source_job_id = $1`,
    [workflowId]
  );
  assert.equal(diffRows.rows.length, 0);

  const mergedTextRows = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM block
     WHERE doc_id = $1
       AND ver = $2
       AND type IN ('text','table')`,
    [jobRows.rows[0].doc_id, jobRows.rows[0].ver]
  );
  assert.ok(Number(mergedTextRows.rows[0]?.count ?? 0) >= 1);
});

test('C3 hard-doc branch: OCR adapter persists raw blobs + patch rows with idempotent effect keys', async (t) => {
  const client = await setupDbOrSkip(t);
  if (!client) return;
  const ocr = await startMockOcrServer();
  t.after(async () => {
    await ocr.close();
  });
  const workflowId = `hard-c3-${process.pid}-${Date.now()}`;
  const timeline = await hardDocWorkflow({
    client,
    workflowId,
    value: ['scan', 'small', 'table|x'].join('\n'),
    sleepMs: 1,
    ocrPolicy: {
      enabled: true,
      engine: 'vllm',
      model: 'zai-org/GLM-OCR',
      baseUrl: ocr.baseUrl,
      timeoutMs: 5000,
      maxPages: 10
    }
  });
  assert.ok(timeline.some((row) => row.step === 'ocr-pages'));
  assert.ok(ocr.requests.length >= 1);

  const ocrPages = await client.query(
    `SELECT page_idx, status, raw_uri, raw_sha
     FROM ocr_page
     WHERE job_id = $1 AND status = 'ocr_ready'
     ORDER BY page_idx ASC`,
    [workflowId]
  );
  assert.ok(ocrPages.rows.length >= 1);
  assert.ok(
    ocrPages.rows.every(
      (row) =>
        typeof row.raw_uri === 'string' &&
        row.raw_uri.startsWith('s3://mem/run/') &&
        typeof row.raw_sha === 'string' &&
        row.raw_sha.length === 64
    )
  );

  const patchRows = await client.query(
    `SELECT page_idx, patch_sha, patch, source_job_id
     FROM ocr_patch
     WHERE doc_id = (
       SELECT doc_id FROM ocr_job WHERE job_id = $1
     ) AND ver = (
       SELECT ver FROM ocr_job WHERE job_id = $1
     )
     ORDER BY page_idx ASC`,
    [workflowId]
  );
  assert.equal(patchRows.rows.length, ocrPages.rows.length);
  assert.ok(
    patchRows.rows.every(
      (row) =>
        typeof row.patch_sha === 'string' &&
        row.patch_sha.length === 64 &&
        typeof row.patch === 'object' &&
        row.source_job_id === workflowId
    )
  );

  const effectRows = await client.query(
    `SELECT effect_key
     FROM side_effects
     WHERE effect_key LIKE $1
     ORDER BY effect_key ASC`,
    [`${workflowId}|ocr-page|%`]
  );
  assert.equal(effectRows.rows.length, ocrPages.rows.length);
});

test('C4 hard-doc branch: merged OCR diffs persist lineage rows and export sidecars', async (t) => {
  const client = await setupDbOrSkip(t);
  if (!client) return;
  const bundlesRoot = await mkdtemp(join(tmpdir(), 'jejakekal-c4-hard-doc-bundles-'));
  t.after(async () => {
    await rm(bundlesRoot, { recursive: true, force: true });
  });
  const ocr = await startMockOcrServer();
  t.after(async () => {
    await ocr.close();
  });
  const workflowId = `hard-c4-${process.pid}-${Date.now()}`;
  const timeline = await hardDocWorkflow({
    client,
    workflowId,
    bundlesRoot,
    value: ['scan', 'small', 'table|x'].join('\n'),
    sleepMs: 1,
    ocrPolicy: {
      enabled: true,
      engine: 'vllm',
      model: 'zai-org/GLM-OCR',
      baseUrl: ocr.baseUrl,
      timeoutMs: 5000,
      maxPages: 10
    }
  });
  assert.ok(timeline.some((row) => row.step === 'ocr-merge-diff'));

  const diffRows = await client.query(
    `SELECT page_idx, before_sha, after_sha, changed_blocks, page_diff_sha, diff_sha
     FROM docir_page_diff
     WHERE source_job_id = $1
     ORDER BY page_idx ASC`,
    [workflowId]
  );
  assert.ok(diffRows.rows.length >= 1);
  assert.ok(
    diffRows.rows.every(
      (row) =>
        typeof row.before_sha === 'string' &&
        row.before_sha.length === 64 &&
        typeof row.after_sha === 'string' &&
        row.after_sha.length === 64 &&
        Number(row.changed_blocks) >= 0 &&
        typeof row.page_diff_sha === 'string' &&
        row.page_diff_sha.length === 64 &&
        typeof row.diff_sha === 'string' &&
        row.diff_sha.length === 64
    )
  );

  const pageVerRows = await client.query(
    `SELECT page_idx, page_sha, source, source_ref_sha
     FROM docir_page_version
     WHERE doc_id = (SELECT doc_id FROM ocr_job WHERE job_id = $1)
       AND ver = (SELECT ver FROM ocr_job WHERE job_id = $1)
       AND source = 'ocr-merge'
     ORDER BY page_idx ASC`,
    [workflowId]
  );
  assert.ok(pageVerRows.rows.length >= 1);
  assert.ok(
    pageVerRows.rows.every(
      (row) =>
        typeof row.page_sha === 'string' &&
        row.page_sha.length === 64 &&
        typeof row.source_ref_sha === 'string' &&
        row.source_ref_sha.length === 64
    )
  );

  const s3Store = createS3BlobStore(defaultS3BlobStoreConfig());
  const exported = await exportRunBundle({ client, bundlesRoot, runId: workflowId, s3Store });
  assert.equal(exported?.run_id, workflowId);
  const reportMd = await readFile(join(exported.run_bundle_path, 'ocr_report.md'), 'utf8');
  const diffMd = await readFile(join(exported.run_bundle_path, 'diff_summary.md'), 'utf8');
  assert.equal(reportMd.includes('# OCR report'), true);
  assert.equal(diffMd.includes('# OCR diff summary'), true);
  const bundle = await readBundle(exported.run_bundle_path);
  assert.ok(Array.isArray(bundle['ocr_pages.json']));
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

  const runCommand = await fetch(`${baseUrl}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd: '/run wf-1' })
  });
  assert.equal(runCommand.status, 400);
  assert.deepEqual(await runCommand.json(), { error: 'invalid_command', cmd: '/run' });

  const openIntent = await fetch(`${baseUrl}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ intent: 'open', args: { artifact_id: 'wf-1:raw' } })
  });
  assert.equal(openIntent.status, 400);
  assert.deepEqual(await openIntent.json(), { error: 'invalid_command', cmd: '/open' });

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

  const badOcrPolicyEngine = await fetch(`${baseUrl}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      intent: 'doc',
      args: { source: 'x' },
      ocrPolicy: {
        enabled: true,
        engine: 'ollama',
        model: 'glm',
        baseUrl: 'http://127.0.0.1:11434',
        timeoutMs: 1000,
        maxPages: 1
      }
    })
  });
  assert.equal(badOcrPolicyEngine.status, 400);
  assert.deepEqual(await badOcrPolicyEngine.json(), {
    error: 'invalid_run_payload',
    field: 'ocrPolicy.engine'
  });
});

test('C5 hard-doc run-start: additive locator/mime routes to hard-doc workflow with deterministic workflowId', async (t) => {
  const client = await setupDbOrSkip(t);
  if (!client) return;
  const ocr = await startMockOcrServer();
  t.after(async () => {
    await ocr.close();
  });
  const prevOcrBaseUrl = process.env.OCR_BASE_URL;
  process.env.OCR_BASE_URL = ocr.baseUrl;
  t.after(() => {
    if (prevOcrBaseUrl == null) {
      delete process.env.OCR_BASE_URL;
      return;
    }
    process.env.OCR_BASE_URL = prevOcrBaseUrl;
  });

  const api = await startApiServer(0);
  t.after(async () => {
    await api.close();
  });
  const baseUrl = `http://127.0.0.1:${api.port}`;
  const hardDocNonce = `${process.pid}-${Date.now()}`;
  const payload = {
    intent: 'doc',
    args: {
      source: ['scan', 'small', 'table|x', `nonce:${hardDocNonce}`].join('\n'),
      locator: `s3://fixtures/hard-doc-${hardDocNonce}.pdf`,
      mime: 'application/pdf'
    },
    sleepMs: 1
  };
  const startRes = await fetch(`${baseUrl}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  assert.equal(startRes.status, 202);
  const started = await startRes.json();
  assert.equal(started.run_id, deriveHardDocWorkflowId(payload));

  const run = await waitForRunTerminal(baseUrl, started.run_id);
  assert.equal(run?.status, 'done');
  assert.equal(run.timeline.some((row) => row.function_name === 'ocr-persist-gate'), true);
  assert.equal(run.timeline.some((row) => row.function_name === 'ocr-pages'), true);
  assert.equal(run.timeline.some((row) => row.function_name === 'ocr-merge-diff'), true);
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
  assert.equal(typeof listed[0].sha256, 'string');
  assert.equal(listed[0].sha256.length, 64);

  const artifactId = `${started.run_id}:raw`;
  const detailRes = await fetch(`${baseUrl}/artifacts/${encodeURIComponent(artifactId)}`);
  assert.equal(detailRes.status, 200);
  const detail = await detailRes.json();
  assert.equal(detail.meta.id, artifactId);
  assert.equal(detail.meta.type, 'raw');
  assert.equal(detail.meta.sha256, listed[0].sha256);
  assert.equal(typeof detail.content, 'string');
  assert.equal(detail.content.includes('artifact-route-c2'), true);
  assert.equal(detail.prov.run_id, started.run_id);
  assert.equal(detail.prov.hash?.artifact_sha256, listed[0].sha256);

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
  const reserveOutput = run.timeline.find((row) => row.function_name === 'reserve-doc')?.output ?? {};
  assert.equal(Object.hasOwn(reserveOutput, 'source'), false);

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
  assert.equal(typeof bundle['operation_outputs.json'][0].output.raw_sha, 'string');
  assert.equal(Object.hasOwn(bundle['operation_outputs.json'][0].output, 'source'), false);
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

test('C5 memo artifact is deterministic markdown with block refs', async (t) => {
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
    body: JSON.stringify({ source: 'c5 memo alpha\nc5 memo beta', sleepMs: 10 })
  });
  assert.equal(startRes.status, 202);
  const started = await startRes.json();
  const run = await waitForRunTerminal(baseUrl, started.run_id);
  assert.equal(run?.status, 'done');
  assert.equal(run.timeline.some((step) => step.function_name === 'emit-exec-memo'), true);

  const detailRes = await fetch(`${baseUrl}/artifacts/${encodeURIComponent(`${started.run_id}:memo`)}`);
  assert.equal(detailRes.status, 200);
  const detail = await detailRes.json();
  assert.equal(detail.meta.type, 'memo');
  assert.equal(detail.meta.format, 'text/markdown');
  assert.equal(typeof detail.content, 'string');
  assert.equal(detail.content.includes('# Exec memo:'), true);
  assert.equal(detail.content.includes('## Key excerpts (block refs)'), true);
  assert.match(detail.content, /\[b:[a-f0-9]{24}\]/);
});

test('C5 bundle manifest adds ingest summary fields additively', async (t) => {
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
    body: JSON.stringify({ source: 'c5 manifest additive', sleepMs: 10 })
  });
  assert.equal(startRes.status, 202);
  const started = await startRes.json();
  const run = await waitForRunTerminal(baseUrl, started.run_id);
  assert.equal(run?.status, 'done');

  const exportRes = await fetch(`${baseUrl}/runs/${encodeURIComponent(started.run_id)}/export`);
  assert.equal(exportRes.status, 200);
  const exported = await exportRes.json();
  assert.equal(typeof exported.run_bundle_path, 'string');
  assert.equal(typeof exported.ingest, 'object');
  assert.equal(typeof exported.ingest.doc_id, 'string');
  assert.equal(typeof exported.ingest.ocr, 'object');
  assert.ok(Array.isArray(exported.ingest.ocr.hard_pages));
  assert.ok(Array.isArray(exported.ingest.ocr.ocr_pages));
  assert.equal('ocr_failures' in exported.ingest.ocr, true);
  assert.equal('ocr_model' in exported.ingest.ocr, true);
  assert.equal('diff_sha' in exported.ingest.ocr, true);
  const bundle = await readBundle(exported.run_bundle_path);
  const manifest = bundle['manifest.json'];
  assert.equal(manifest.workflowId, started.run_id);
  assert.equal(typeof manifest.ingest, 'object');
  assert.equal(typeof manifest.ingest.doc_id, 'string');
  assert.equal(typeof manifest.ingest.ver, 'number');
  assert.equal(typeof manifest.ingest.raw_sha, 'string');
  assert.equal(typeof manifest.ingest.keys, 'object');
  assert.equal(typeof manifest.ingest.counts, 'object');
  assert.equal(typeof manifest.ingest.timing_ms, 'object');
  assert.equal(typeof manifest.ingest.stderr_ref, 'string');
  assert.equal(typeof manifest.ingest.ocr, 'object');
  assert.ok(Array.isArray(manifest.ingest.ocr.hard_pages));
  assert.ok(Array.isArray(manifest.ingest.ocr.ocr_pages));
  assert.equal('ocr_failures' in manifest.ingest.ocr, true);
  assert.equal('ocr_model' in manifest.ingest.ocr, true);
  assert.equal('diff_sha' in manifest.ingest.ocr, true);
  assert.ok(Array.isArray(manifest.artifact_refs));
  assert.ok(Array.isArray(manifest.step_summaries));
});

test('C6 OCR sidecars always include diff_summary.md even when merge diff is empty', async (t) => {
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
    body: JSON.stringify({
      intent: 'doc',
      args: {
        source: ['scan', 'table|x', `nonce:${process.pid}-${Date.now()}`].join('\n'),
        mime: 'application/pdf'
      },
      ocrPolicy: {
        enabled: false,
        engine: 'vllm',
        model: 'zai-org/GLM-OCR',
        baseUrl: 'http://127.0.0.1:8000',
        timeoutMs: 120000,
        maxPages: 10
      },
      sleepMs: 10
    })
  });
  assert.equal(startRes.status, 202);
  const started = await startRes.json();
  const run = await waitForRunTerminal(baseUrl, started.run_id);
  assert.equal(run?.status, 'done');

  const exportRes = await fetch(`${baseUrl}/runs/${encodeURIComponent(started.run_id)}/export`);
  assert.equal(exportRes.status, 200);
  const exported = await exportRes.json();
  const diffMd = await readFile(join(exported.run_bundle_path, 'diff_summary.md'), 'utf8');
  assert.equal(diffMd.includes('# OCR diff summary'), true);
  assert.equal(diffMd.includes('- diff_sha: none'), true);
  assert.equal(diffMd.includes('- none'), true);
});

test('C4 fts correctness: block ledger persists and @@ ranked query is deterministic', async (t) => {
  const client = await setupDbOrSkip(t);
  if (!client) return;
  const api = await startApiServer(0);
  t.after(async () => {
    await api.close();
  });
  const baseUrl = `http://127.0.0.1:${api.port}`;
  const source = 'invoice alpha\ninvoice invoice beta\ngamma';
  const startRes = await fetch(`${baseUrl}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source, sleepMs: 10 })
  });
  assert.equal(startRes.status, 202);
  const started = await startRes.json();
  const run = await waitForRunTerminal(baseUrl, started.run_id);
  assert.equal(run?.status, 'done');
  assert.equal(run.timeline.some((step) => step.function_name === 'normalize-docir'), true);
  assert.equal(run.timeline.some((step) => step.function_name === 'index-fts'), true);

  const indexRes = await client.query(
    `SELECT
       to_regclass('public.block_tsv_gin') AS block_idx,
       to_regclass('public.doc_block_fts_gin') AS doc_block_idx,
       to_regclass('public.table_cell_vec_gin') AS table_cell_idx,
       to_regclass('public.doc_block_title_trgm_gin') AS doc_block_title_trgm_idx,
       to_regclass('public.doc_block_entity_trgm_gin') AS doc_block_entity_trgm_idx,
       to_regclass('public.doc_block_key_trgm_gin') AS doc_block_key_trgm_idx,
       to_regclass('public.table_cell_key_trgm_gin') AS table_cell_key_trgm_idx,
       to_regclass('public.doc_block_vec_hnsw') AS doc_block_vec_hnsw_idx`
  );
  assert.equal(indexRes.rows[0].block_idx, 'block_tsv_gin');
  assert.equal(indexRes.rows[0].doc_block_idx, 'doc_block_fts_gin');
  assert.equal(indexRes.rows[0].table_cell_idx, 'table_cell_vec_gin');
  assert.equal(indexRes.rows[0].doc_block_title_trgm_idx, 'doc_block_title_trgm_gin');
  assert.equal(indexRes.rows[0].doc_block_entity_trgm_idx, 'doc_block_entity_trgm_gin');
  assert.equal(indexRes.rows[0].doc_block_key_trgm_idx, 'doc_block_key_trgm_gin');
  assert.equal(indexRes.rows[0].table_cell_key_trgm_idx, 'table_cell_key_trgm_gin');
  assert.equal(indexRes.rows[0].doc_block_vec_hnsw_idx, 'doc_block_vec_hnsw');

  const blockRows = await client.query(
    `SELECT doc_id, ver, block_id, block_sha, tsv
     FROM block
     WHERE doc_id IN (SELECT doc_id FROM doc_ver ORDER BY created_at DESC LIMIT 1)
     ORDER BY block_id ASC`
  );
  assert.equal(blockRows.rows.length >= 3, true);
  assert.equal(blockRows.rows.every((row) => typeof row.block_sha === 'string' && row.block_sha.length === 64), true);
  assert.equal(blockRows.rows.every((row) => row.tsv != null), true);

  const docBlockRows = await client.query(
    `SELECT b.block_id, b.block_sha, f.vec
     FROM doc_block b
     JOIN doc_block_fts f ON f.block_pk = b.id
     WHERE b.doc_id = $1
       AND b.ver = $2
     ORDER BY b.block_id ASC`,
    [blockRows.rows[0].doc_id, blockRows.rows[0].ver]
  );
  assert.equal(docBlockRows.rows.length, blockRows.rows.length);
  assert.equal(
    docBlockRows.rows.every((row) => typeof row.block_sha === 'string' && row.block_sha.length === 64 && row.vec != null),
    true
  );
  const docBlockVecRows = await client.query(
    `SELECT b.block_id, v.model, v.emb
     FROM doc_block b
     JOIN doc_block_vec v ON v.block_pk = b.id
     WHERE b.doc_id = $1
       AND b.ver = $2
     ORDER BY b.block_id ASC`,
    [blockRows.rows[0].doc_id, blockRows.rows[0].ver]
  );
  assert.equal(docBlockVecRows.rows.length >= 1, true);
  assert.equal(docBlockVecRows.rows.every((row) => typeof row.model === 'string' && row.model.length >= 1), true);
  assert.equal(docBlockVecRows.rows.every((row) => row.emb != null), true);

  const hits = await queryRankedBlocksByTsQuery(client, {
    query: 'invoice',
    limit: 20,
    scope: { namespaces: ['default'] }
  });
  assert.equal(hits.length >= 1, true);
  assert.equal(Array.isArray(hits[0].lane), true);
  assert.equal(Array.isArray(hits[0].lane_reasons), true);
  assert.equal(typeof hits[0].cite, 'object');
  assert.equal(hits[0].cite.doc_version, hits[0].ver);
  assert.equal(typeof hits[0].cite.block_hash, 'string');
  assert.equal(Object.hasOwn(hits[0], 'text'), false);
  assert.equal(
    hits.every((row, index) => index === 0 || row.rank <= hits[index - 1].rank),
    true
  );
  const misses = await queryRankedBlocksByTsQuery(client, {
    query: 'nonexistenttoken',
    limit: 20,
    scope: { namespaces: ['default'] }
  });
  assert.deepEqual(misses, []);

  const invoiceAlphaRow = await client.query(
    `SELECT block_id
     FROM doc_block
     WHERE doc_id = $1
       AND ver = $2
       AND text ILIKE '%invoice alpha%'
     ORDER BY block_id ASC
     LIMIT 1`,
    [blockRows.rows[0].doc_id, blockRows.rows[0].ver]
  );
  assert.equal(invoiceAlphaRow.rows.length, 1);
  const gammaRow = await client.query(
    `SELECT block_id
     FROM doc_block
     WHERE doc_id = $1
       AND ver = $2
       AND text ILIKE '%gamma%'
     ORDER BY block_id ASC
     LIMIT 1`,
    [blockRows.rows[0].doc_id, blockRows.rows[0].ver]
  );
  assert.equal(gammaRow.rows.length, 1);
  const betaRows = await client.query(
    `SELECT block_id
     FROM doc_block
     WHERE doc_id = $1
       AND ver = $2
       AND text ILIKE '%beta%'
     ORDER BY block_id ASC`,
    [blockRows.rows[0].doc_id, blockRows.rows[0].ver]
  );
  const betaBlockIds = new Set(betaRows.rows.map((row) => String(row.block_id)));

  const phraseHitsA = await queryRankedBlocksByTsQuery(client, {
    query: '"invoice alpha"',
    limit: 20,
    scope: { namespaces: ['default'] }
  });
  const phraseHitsB = await queryRankedBlocksByTsQuery(client, {
    query: '"invoice alpha"',
    limit: 20,
    scope: { namespaces: ['default'] }
  });
  assert.equal(phraseHitsA.length >= 1, true);
  assert.equal(phraseHitsA[0].block_id, String(invoiceAlphaRow.rows[0].block_id));
  assert.deepEqual(
    phraseHitsA.map((row) => `${row.doc_id}:${row.ver}:${row.block_id}`),
    phraseHitsB.map((row) => `${row.doc_id}:${row.ver}:${row.block_id}`)
  );

  const orHitsA = await queryRankedBlocksByTsQuery(client, {
    query: 'invoice OR gamma',
    limit: 20,
    scope: { namespaces: ['default'] }
  });
  const orHitsB = await queryRankedBlocksByTsQuery(client, {
    query: 'invoice OR gamma',
    limit: 20,
    scope: { namespaces: ['default'] }
  });
  assert.equal(orHitsA.some((row) => row.block_id === String(gammaRow.rows[0].block_id)), true);
  assert.deepEqual(
    orHitsA.map((row) => `${row.doc_id}:${row.ver}:${row.block_id}`),
    orHitsB.map((row) => `${row.doc_id}:${row.ver}:${row.block_id}`)
  );

  const dashHitsA = await queryRankedBlocksByTsQuery(client, {
    query: 'invoice -beta',
    limit: 20,
    scope: { namespaces: ['default'] }
  });
  const dashHitsB = await queryRankedBlocksByTsQuery(client, {
    query: 'invoice -beta',
    limit: 20,
    scope: { namespaces: ['default'] }
  });
  assert.equal(dashHitsA.length >= 1, true);
  assert.equal(dashHitsA.every((row) => !betaBlockIds.has(row.block_id)), true);
  assert.deepEqual(
    dashHitsA.map((row) => `${row.doc_id}:${row.ver}:${row.block_id}`),
    dashHitsB.map((row) => `${row.doc_id}:${row.ver}:${row.block_id}`)
  );

  const indexable = await inspectLexicalQuery(client, { query: 'invoice OR gamma', language: 'english' });
  assert.equal(indexable.indexable, true);
  const nonIndexable = await inspectLexicalQuery(client, { query: 'the', language: 'english' });
  assert.equal(nonIndexable.indexable, false);
  const snippet = await buildLexicalHeadline(client, {
    query: '"invoice alpha"',
    language: 'english',
    docId: String(blockRows.rows[0].doc_id),
    version: Number(blockRows.rows[0].ver),
    blockId: String(invoiceAlphaRow.rows[0].block_id)
  });
  assert.equal(typeof snippet, 'string');
  assert.equal(String(snippet).includes('<mark>'), true);

  const trgmHitsA = await queryRankedBlocksByTsQuery(client, {
    query: 'invocie',
    limit: 20,
    scope: { namespaces: ['default'] }
  });
  const trgmHitsB = await queryRankedBlocksByTsQuery(client, {
    query: 'invocie',
    limit: 20,
    scope: { namespaces: ['default'] }
  });
  assert.equal(trgmHitsA.length >= 1, true);
  assert.deepEqual(
    trgmHitsA.map((row) => `${row.doc_id}:${row.ver}:${row.block_id}`),
    trgmHitsB.map((row) => `${row.doc_id}:${row.ver}:${row.block_id}`)
  );

  const vecHitsA = await queryRankedBlocksByTsQuery(client, {
    query: 'invoice alpha',
    limit: 20,
    enableVector: true,
    vector: { efSearch: 64, candidateLimit: 20 },
    scope: { namespaces: ['default'] }
  });
  const vecHitsB = await queryRankedBlocksByTsQuery(client, {
    query: 'invoice alpha',
    limit: 20,
    enableVector: true,
    vector: { efSearch: 64, candidateLimit: 20 },
    scope: { namespaces: ['default'] }
  });
  assert.equal(vecHitsA.length >= 1, true);
  assert.equal(vecHitsA.some((row) => row.lane.includes('vector')), true);
  assert.deepEqual(
    vecHitsA.map((row) => `${row.doc_id}:${row.ver}:${row.block_id}`),
    vecHitsB.map((row) => `${row.doc_id}:${row.ver}:${row.block_id}`)
  );

  const vecRows = await queryVectorLaneRows(client, {
    queryVector: new Array(1536).fill(0).map((_, idx) => (idx === 0 ? 1 : 0)),
    model: String(docBlockVecRows.rows[0].model),
    limit: 5,
    candidateLimit: 5,
    efSearch: 32,
    indexType: 'hnsw',
    scope: { namespaces: ['default'] }
  });
  assert.equal(Array.isArray(vecRows), true);

  const movedBlock = trgmHitsA[0];
  await client.query(
    `UPDATE doc_block
     SET ns = 'tenant-a'
     WHERE doc_id = $1
       AND ver = $2
       AND block_id = $3`,
    [movedBlock.doc_id, movedBlock.ver, movedBlock.block_id]
  );
  const isolatedHits = await queryRankedBlocksByTsQuery(client, {
    query: 'invocie',
    limit: 20,
    scope: { namespaces: ['default'] }
  });
  assert.equal(
    isolatedHits.some(
      (row) => row.doc_id === movedBlock.doc_id && row.ver === movedBlock.ver && row.block_id === movedBlock.block_id
    ),
    false
  );

  await client.query('SET enable_seqscan = off');
  const explainResult = await client.query(
    `EXPLAIN (FORMAT JSON)
     SELECT b.id
     FROM doc_block b
     WHERE b.ns = ANY($2::text[])
       AND (
         (b.title_norm IS NOT NULL AND b.title_norm % $1)
         OR (b.entity_norm IS NOT NULL AND b.entity_norm % $1)
         OR (b.key_norm IS NOT NULL AND b.key_norm % $1)
       )
     ORDER BY b.id ASC
     LIMIT 20`,
    ['invocie', ['default']]
  );
  await client.query('RESET enable_seqscan');
  const explainJson = explainResult.rows[0]?.['QUERY PLAN']?.[0];
  const explainText = JSON.stringify(explainJson);
  const hasIndexScanNode =
    explainText.includes('"Node Type":"Bitmap Index Scan"') ||
    explainText.includes('"Node Type":"Index Scan"') ||
    explainText.includes('"Node Type":"Index Only Scan"');
  assert.equal(
    explainText.includes('doc_block_title_trgm_gin') ||
      explainText.includes('doc_block_entity_trgm_gin') ||
      explainText.includes('doc_block_key_trgm_gin') ||
      hasIndexScanNode,
    true
  );

  await client.query('SET enable_seqscan = off');
  const hnswExplain = await client.query(
    `EXPLAIN (FORMAT JSON)
     SELECT v.block_pk
     FROM doc_block_vec v
     JOIN doc_block b ON b.id = v.block_pk
     WHERE b.ns = ANY($2::text[])
       AND v.model = $3::text
     ORDER BY v.emb <=> $1::vector ASC, b.id ASC
     LIMIT 10`,
    ['[1,0,0' + ',0'.repeat(1533) + ']', ['default'], String(docBlockVecRows.rows[0].model)]
  );
  await client.query('RESET enable_seqscan');
  const hnswExplainText = JSON.stringify(hnswExplain.rows[0]?.['QUERY PLAN']?.[0]);
  const hasVecIndexScan =
    hnswExplainText.includes('doc_block_vec_hnsw') ||
    hnswExplainText.includes('"Node Type":"Index Scan"') ||
    hnswExplainText.includes('"Node Type":"Index Only Scan"');
  assert.equal(hasVecIndexScan, true);
});

test('C5 table lane: deterministic table_cell addresses + exact-key fast path + fts fallback survive reingest', async (t) => {
  const client = await setupDbOrSkip(t);
  if (!client) return;

  const docId = `doc-c5-table-${process.pid}-${Date.now()}`;
  const rawSha = sha256(`raw:${docId}`);
  await client.query(
    `INSERT INTO doc (doc_id, raw_sha, filename, mime, byte_len, latest_ver)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [docId, rawSha, 'table.txt', 'text/plain', 12, 1]
  );
  await client.query(
    `INSERT INTO doc_ver (doc_id, ver, raw_sha, marker_config_sha)
     VALUES ($1,$2,$3,$4)`,
    [docId, 1, rawSha, 'c'.repeat(64)]
  );

  const tableBlock = {
    block_id: 'tbl-c5-1',
    type: 'table',
    page: 1,
    bbox: [0, 0, 10, 10],
    text: 'inventory table',
    data: {
      headers: ['item', 'qty', 'amount'],
      rows: [
        { qty: '2', amount: '$10.50', item: 'Widget Alpha' },
        { item: 'Widget Beta', amount: '$20.00', qty: '4' }
      ]
    },
    block_sha: 'ab'.repeat(32)
  };
  await upsertBlockLedger(client, {
    docId,
    version: 1,
    blocks: [tableBlock],
    provenance: { source: 'test-c5' }
  });
  await populateBlockTsv(client, { docId, version: 1, language: 'english' });

  const exactA = await queryTableCellLaneRows(client, {
    query: 'amount',
    language: 'english',
    limit: 10,
    scope: { namespaces: ['default'] }
  });
  const exactB = await queryTableCellLaneRows(client, {
    query: 'amount',
    language: 'english',
    limit: 10,
    scope: { namespaces: ['default'] }
  });
  assert.equal(exactA.length >= 2, true);
  assert.equal(exactA.every((row) => row.match_kind === 'exact'), true);
  assert.deepEqual(
    exactA.map((row) => [row.table_id, row.row_idx, row.col_idx]),
    exactB.map((row) => [row.table_id, row.row_idx, row.col_idx])
  );
  assert.equal(exactA[0].key_norm, 'amount');
  assert.equal(typeof exactA[0].cite, 'object');
  assert.equal(exactA[0].cite.doc_version, 1);
  assert.equal(exactA[0].cite.page, 1);
  assert.equal(typeof exactA[0].cite.block_hash, 'string');
  assert.equal(typeof exactA[0].cite.block_id, 'string');
  assert.notEqual(exactA[0].table_id, tableBlock.block_id);

  const ftsA = await queryTableCellLaneRows(client, {
    query: 'widget beta',
    language: 'english',
    limit: 10,
    scope: { namespaces: ['default'] }
  });
  const ftsB = await queryTableCellLaneRows(client, {
    query: 'widget beta',
    language: 'english',
    limit: 10,
    scope: { namespaces: ['default'] }
  });
  assert.equal(ftsA.length >= 1, true);
  assert.equal(ftsA.every((row) => row.match_kind === 'fts'), true);
  assert.deepEqual(
    ftsA.map((row) => [row.table_id, row.row_idx, row.col_idx]),
    ftsB.map((row) => [row.table_id, row.row_idx, row.col_idx])
  );

  const beforeRows = await client.query(
    `SELECT table_id, row_idx, col_idx, key_norm, val_norm, cite::text AS cite
     FROM table_cell
     WHERE doc_id = $1 AND ver = 1
     ORDER BY table_id ASC, row_idx ASC, col_idx ASC`,
    [docId]
  );
  await upsertBlockLedger(client, {
    docId,
    version: 1,
    blocks: [tableBlock],
    provenance: { source: 'test-c5-reingest' }
  });
  await populateBlockTsv(client, { docId, version: 1, language: 'english' });
  const afterRows = await client.query(
    `SELECT table_id, row_idx, col_idx, key_norm, val_norm, cite::text AS cite
     FROM table_cell
     WHERE doc_id = $1 AND ver = 1
     ORDER BY table_id ASC, row_idx ASC, col_idx ASC`,
    [docId]
  );
  assert.deepEqual(beforeRows.rows, afterRows.rows);
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

test('P2 workflowId claim hash scope is canonical intent+args (execution controls ignored)', async (t) => {
  const client = await setupDbOrSkip(t);
  if (!client) return;
  const api = await startApiServer(0);
  t.after(async () => {
    await api.close();
  });

  const baseUrl = `http://127.0.0.1:${api.port}`;
  const workflowId = `wf-hash-scope-${process.pid}-${Date.now()}`;
  const payloadA = { intent: 'doc', args: { source: 'same-hash' }, workflowId, sleepMs: 5, useLlm: false };
  const payloadB = { intent: 'doc', args: { source: 'same-hash' }, workflowId, sleepMs: 50, useLlm: true };

  const first = await fetch(`${baseUrl}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payloadA)
  });
  assert.equal(first.status, 202);
  const firstBody = await first.json();
  const second = await fetch(`${baseUrl}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payloadB)
  });
  assert.equal(second.status, 202);
  const secondBody = await second.json();
  assert.equal(secondBody.run_id, firstBody.run_id);
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

test('P0 persisted malformed artifact uri fails closed as opaque 500 across readers', async (t) => {
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
    body: JSON.stringify({ source: 'c7-invalid-uri', sleepMs: 10 })
  });
  assert.equal(startRes.status, 202);
  const started = await startRes.json();
  const run = await waitForRunTerminal(baseUrl, started.run_id);
  assert.equal(run?.status, 'done');

  const docirRow = await client.query(
    `SELECT id, sha256, prov
     FROM artifact
     WHERE run_id = $1 AND type = 'docir'
     ORDER BY created_at ASC, id ASC
     LIMIT 1`,
    [started.run_id]
  );
  assert.equal(docirRow.rows.length, 1);
  const badArtifactId = `${started.run_id}:docir-bad-uri`;
  await client.query(
    `INSERT INTO artifact (id, run_id, type, format, uri, sha256, title, status, visibility, supersedes_id, prov)
     VALUES ($1,$2,'docir','application/json',$3,$4,'Tampered DocIR','final','user',NULL,$5::jsonb)`,
    [badArtifactId, started.run_id, 'http://bad-uri', docirRow.rows[0].sha256, JSON.stringify(docirRow.rows[0].prov)]
  );

  const detailRes = await fetch(`${baseUrl}/artifacts/${encodeURIComponent(badArtifactId)}`);
  assert.equal(detailRes.status, 500);
  assert.deepEqual(await detailRes.json(), { error: 'internal_error' });

  const downloadRes = await fetch(`${baseUrl}/artifacts/${encodeURIComponent(badArtifactId)}/download`);
  assert.equal(downloadRes.status, 500);
  assert.deepEqual(await downloadRes.json(), { error: 'internal_error' });

  const exportRes = await fetch(`${baseUrl}/runs/${encodeURIComponent(started.run_id)}/export`);
  assert.equal(exportRes.status, 500);
  assert.deepEqual(await exportRes.json(), { error: 'internal_error' });

  const bundleRes = await fetch(`${baseUrl}/runs/${encodeURIComponent(started.run_id)}/bundle`);
  assert.equal(bundleRes.status, 500);
  assert.deepEqual(await bundleRes.json(), { error: 'internal_error' });
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

test('P1 source compat sunset matrix: pre-window accepts `{source}`, post-window rejects typed 400', async (t) => {
  const client = await setupDbOrSkip(t);
  if (!client) return;
  const prevCompatDay = process.env.JEJAKEKAL_COMPAT_TODAY;
  const api = await startApiServer(0);
  t.after(async () => {
    await api.close();
    if (prevCompatDay == null) {
      delete process.env.JEJAKEKAL_COMPAT_TODAY;
    } else {
      process.env.JEJAKEKAL_COMPAT_TODAY = prevCompatDay;
    }
  });

  const baseUrl = `http://127.0.0.1:${api.port}`;
  process.env.JEJAKEKAL_COMPAT_TODAY = '2026-06-29';
  const pre = await fetch(`${baseUrl}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'compat-pre', sleepMs: 10 })
  });
  assert.equal(pre.status, 202);

  process.env.JEJAKEKAL_COMPAT_TODAY = '2026-07-01';
  const post = await fetch(`${baseUrl}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'compat-post', sleepMs: 10 })
  });
  assert.equal(post.status, 400);
  assert.deepEqual(await post.json(), { error: 'source_compat_expired', until: '2026-06-30' });
});

test('P1 artifact sha256 DB invariant rejects empty digest rows', async (t) => {
  const client = await setupDbOrSkip(t);
  if (!client) return;
  await assert.rejects(
    () =>
      client.query(
        `INSERT INTO artifact (id, run_id, type, format, uri, sha256, title, status, visibility, supersedes_id, prov)
         VALUES ('sha-empty','sha-empty-run','memo','text/markdown','s3://mem/run/x','','Bad SHA','final','user',NULL,'{}'::jsonb)`
      ),
    /artifact_sha256_hex64_chk/
  );
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
