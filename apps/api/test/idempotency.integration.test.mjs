import test from 'node:test';
import assert from 'node:assert/strict';
import { callIdempotentEffect } from '../src/effects.mjs';
import { shutdownDbosRuntime } from '../src/dbos-runtime.mjs';
import { defaultWorkflow, readOperationOutputs } from '../src/workflow.mjs';
import { setupDbOrSkip } from './helpers.mjs';
import { freezeDeterminism } from '../../../packages/core/src/determinism.mjs';

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
  assert.equal(storeRaw.output?.effect_replayed, true);

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
