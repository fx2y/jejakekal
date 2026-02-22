import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultWorkflow, readTimeline } from '../src/workflow.mjs';
import { setupDbOrSkip } from './helpers.mjs';
import { freezeDeterminism } from '../../../packages/core/src/determinism.mjs';

test('workflow runs through all deterministic steps', async (t) => {
  const client = await setupDbOrSkip(t);
  if (!client) return;
  const unfreeze = freezeDeterminism({ now: Date.parse('2026-02-22T00:00:00.000Z'), random: 0.25 });
  t.after(() => unfreeze());

  const workflowId = `wf-${Date.now()}`;
  const timeline = await defaultWorkflow({ client, workflowId, value: 'abc' });

  assert.equal(timeline.length, 3);
  assert.equal(timeline[0].step, 'prepare');
  assert.equal(timeline[2].step, 'finalize');

  const events = await readTimeline(client, workflowId);
  assert.ok(events.length >= 6);
});
