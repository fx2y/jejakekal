import test from 'node:test';
import assert from 'node:assert/strict';
import { callIdempotentEffect } from '../src/effects.mjs';
import { shutdownDbosRuntime } from '../src/dbos-runtime.mjs';
import { defaultWorkflow, readOperationOutputs } from '../src/workflow.mjs';
import { setupDbOrSkip } from './helpers.mjs';
import { freezeDeterminism } from '../../../packages/core/src/determinism.mjs';

test('same workflowID does not duplicate side effects', async (t) => {
  const client = await setupDbOrSkip(t);
  if (!client) return;
  const unfreeze = freezeDeterminism({ now: Date.parse('2026-02-22T00:00:00.000Z'), random: 0.25 });
  t.after(() => unfreeze());
  t.after(async () => {
    await shutdownDbosRuntime();
  });

  const workflowId = `idem-${process.pid}-${Date.now()}`;
  const first = await defaultWorkflow({ client, workflowId, value: 'abc' });
  const second = await defaultWorkflow({ client, workflowId, value: 'abc' });

  const firstEffect = first.find((step) => step.step === 'side-effect');
  const secondEffect = second.find((step) => step.step === 'side-effect');
  assert.equal(firstEffect?.output?.replayed, false);
  assert.equal(secondEffect?.output?.replayed, false);

  const countRes = await client.query('SELECT COUNT(*)::int AS c FROM side_effects');
  assert.equal(countRes.rows[0].c, 1);

  const outputs = await readOperationOutputs(client, workflowId);
  assert.equal(outputs.filter((row) => row.function_name === 'side-effect').length, 1);
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
