import test from 'node:test';
import assert from 'node:assert/strict';
import { readTimeline, runWorkflow } from '../src/workflow.mjs';
import { setupDbOrSkip } from './helpers.mjs';
import { freezeDeterminism } from '../../../packages/core/src/determinism.mjs';

test('crash then resume restarts from last completed step (100x)', async (t) => {
  const client = await setupDbOrSkip(t);
  if (!client) return;
  const unfreeze = freezeDeterminism({ now: Date.parse('2026-02-22T00:00:00.000Z'), random: 0.25 });
  t.after(() => unfreeze());

  for (let i = 0; i < 100; i += 1) {
    const workflowId = `replay-${Date.now()}-${i}`;
    const steps = [
      { name: 'a', run: async () => ({ n: 1 }) },
      { name: 'b', run: async () => ({ n: 2 }) },
      { name: 'c', run: async () => ({ n: 3 }) }
    ];

    await assert.rejects(
      runWorkflow({ client, workflowId, steps, crashAfterStep: 'b' }),
      /forced-crash:b/
    );

    const resumed = await runWorkflow({ client, workflowId, steps });
    assert.equal(resumed[0].phase, 'resume-skip');
    assert.equal(resumed[1].phase, 'resume-skip');
    assert.equal(resumed[2].phase, 'completed');

    const events = await readTimeline(client, workflowId);
    const skipCount = events.filter((event) => event.phase === 'resume-skip').length;
    assert.equal(skipCount, 2);
  }
});
