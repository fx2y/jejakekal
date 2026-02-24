import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { callIdempotentEffect } from '../src/effects.mjs';
import { shutdownDbosRuntime } from '../src/dbos-runtime.mjs';
import { defaultWorkflow, hardDocWorkflow, readOperationOutputs } from '../src/workflow.mjs';
import { setupDbOrSkip } from './helpers.mjs';
import { freezeDeterminism } from '../../../packages/core/src/determinism.mjs';
import { closeServer, listenLocal } from '../src/http.mjs';

async function startMockOcrServer() {
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: 'ocr text' } }]
      })
    );
  });
  const port = await listenLocal(server, 0);
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => closeServer(server)
  };
}

test('same workflowID does not duplicate parse persistence steps', async (t) => {
  const client = await setupDbOrSkip(t);
  if (!client) return;
  const unfreeze = freezeDeterminism({ now: Date.parse('2026-02-22T00:00:00.000Z'), random: 0.25 });
  t.after(() => unfreeze());
  t.after(async () => {
    await shutdownDbosRuntime();
  });

  const workflowId = `idem-${process.pid}-${Date.now()}`;
  await defaultWorkflow({ client, workflowId, value: 'abc' });
  await defaultWorkflow({ client, workflowId, value: 'abc' });

  const countRes = await client.query('SELECT COUNT(*)::int AS c FROM artifact WHERE run_id = $1', [workflowId]);
  assert.equal(countRes.rows[0].c, 4);

  const outputs = await readOperationOutputs(client, workflowId);
  assert.equal(outputs.filter((row) => row.function_name === 'store-parse-outputs').length, 1);
  assert.equal(outputs.filter((row) => row.function_name === 'marker-convert').length, 1);
});

test('concurrent callIdempotentEffect for same key executes effect exactly once', async (t) => {
  const client = await setupDbOrSkip(t);
  if (!client) return;
  const unfreeze = freezeDeterminism({ now: Date.parse('2026-02-22T00:00:00.000Z'), random: 0.25 });
  t.after(() => unfreeze());

  let effectCalls = 0;
  const effectFn = async () => {
    effectCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return { sent: true };
  };

  const [first, second] = await Promise.all([
    callIdempotentEffect(client, 'race-key', effectFn),
    callIdempotentEffect(client, 'race-key', effectFn)
  ]);

  assert.equal(effectCalls, 1);
  assert.equal(first.response.sent, true);
  assert.equal(second.response.sent, true);
  assert.equal(
    [first.replayed, second.replayed].filter(Boolean).length,
    1
  );

  const countRes = await client.query('SELECT COUNT(*)::int AS c FROM side_effects WHERE effect_key = $1', ['race-key']);
  assert.equal(countRes.rows[0].c, 1);
});

test('store-raw retry after post-effect failure replays idempotent effect response', async (t) => {
  const client = await setupDbOrSkip(t);
  if (!client) return;
  const unfreeze = freezeDeterminism({ now: Date.parse('2026-02-22T00:00:00.000Z'), random: 0.25 });
  const prevFailpoint = process.env.JEJAKEKAL_FAIL_AFTER_STORE_RAW_EFFECT_ONCE;
  process.env.JEJAKEKAL_FAIL_AFTER_STORE_RAW_EFFECT_ONCE = '1';
  t.after(() => {
    unfreeze();
    if (prevFailpoint == null) {
      delete process.env.JEJAKEKAL_FAIL_AFTER_STORE_RAW_EFFECT_ONCE;
    } else {
      process.env.JEJAKEKAL_FAIL_AFTER_STORE_RAW_EFFECT_ONCE = prevFailpoint;
    }
  });
  t.after(async () => {
    await shutdownDbosRuntime();
  });

  const workflowId = `idem-store-raw-${process.pid}-${Date.now()}`;
  await defaultWorkflow({ client, workflowId, value: 'abc' });

  const outputs = await readOperationOutputs(client, workflowId);
  const storeRaw = outputs.find((row) => row.function_name === 'store-raw');
  assert.ok(storeRaw);
  const storeRawOutput =
    storeRaw.output && typeof storeRaw.output === 'object' && !Array.isArray(storeRaw.output)
      ? /** @type {Record<string, unknown>} */ (storeRaw.output)
      : {};
  assert.equal(storeRawOutput.effect_replayed, true);

  const countRes = await client.query(
    `SELECT COUNT(*)::int AS c
     FROM side_effects
     WHERE effect_key LIKE $1`,
    [`${workflowId}|store-raw|%`]
  );
  assert.equal(countRes.rows[0].c, 1);
});

test('workflow external write steps execute via idempotent effect-key registry', async (t) => {
  const client = await setupDbOrSkip(t);
  if (!client) return;
  const unfreeze = freezeDeterminism({ now: Date.parse('2026-02-22T00:00:00.000Z'), random: 0.25 });
  t.after(() => unfreeze());
  t.after(async () => {
    await shutdownDbosRuntime();
  });

  const workflowId = `idem-effects-${process.pid}-${Date.now()}`;
  await defaultWorkflow({ client, workflowId, value: 'abc' });

  const rows = await client.query(
    `SELECT effect_key
     FROM side_effects
     WHERE effect_key LIKE $1
     ORDER BY effect_key ASC`,
    [`${workflowId}|%`]
  );
  const keys = rows.rows.map((row) => String(row.effect_key));
  assert.ok(keys.some((key) => key.includes('|store-raw|')));
  assert.ok(keys.some((key) => key.includes('|marker-convert|')));
  assert.ok(keys.some((key) => key.includes('|store-parse-outputs|')));
  assert.ok(keys.some((key) => key.includes('|emit-exec-memo|')));
});

test('OCR retry after post-effect failure replays per-page OCR side effects', async (t) => {
  const client = await setupDbOrSkip(t);
  if (!client) return;
  const unfreeze = freezeDeterminism({ now: Date.parse('2026-02-22T00:00:00.000Z'), random: 0.25 });
  const prevFailpoint = process.env.JEJAKEKAL_FAIL_AFTER_OCR_EFFECT_ONCE;
  process.env.JEJAKEKAL_FAIL_AFTER_OCR_EFFECT_ONCE = '1';
  const ocr = await startMockOcrServer();
  t.after(async () => {
    unfreeze();
    await ocr.close();
    if (prevFailpoint == null) {
      delete process.env.JEJAKEKAL_FAIL_AFTER_OCR_EFFECT_ONCE;
    } else {
      process.env.JEJAKEKAL_FAIL_AFTER_OCR_EFFECT_ONCE = prevFailpoint;
    }
  });
  t.after(async () => {
    await shutdownDbosRuntime();
  });

  const workflowId = `idem-ocr-${process.pid}-${Date.now()}`;
  await hardDocWorkflow({
    client,
    workflowId,
    value: ['scan', 'small', 'table|x'].join('\n'),
    ocrPolicy: {
      enabled: true,
      engine: 'vllm',
      model: 'zai-org/GLM-OCR',
      baseUrl: ocr.baseUrl,
      timeoutMs: 5000,
      maxPages: 10
    }
  });

  const outputs = await readOperationOutputs(client, workflowId);
  const ocrStep = outputs.find((row) => row.function_name === 'ocr-pages');
  assert.ok(ocrStep);
  const ocrOutput =
    ocrStep.output && typeof ocrStep.output === 'object' && !Array.isArray(ocrStep.output)
      ? /** @type {Record<string, unknown>} */ (ocrStep.output)
      : {};
  const pages = Array.isArray(ocrOutput.ocr_pages) ? ocrOutput.ocr_pages : [];
  assert.ok(pages.length >= 1);
  assert.ok(pages.some((row) => row.effect_replayed === true));

  const countRes = await client.query(
    `SELECT COUNT(*)::int AS c
     FROM side_effects
     WHERE effect_key LIKE $1`,
    [`${workflowId}|ocr-page|%`]
  );
  assert.equal(countRes.rows[0].c, pages.length);
});
