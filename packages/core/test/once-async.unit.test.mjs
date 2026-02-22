import test from 'node:test';
import assert from 'node:assert/strict';
import { onceAsync } from '../src/once-async.mjs';

test('onceAsync runs close once after success', async () => {
  let calls = 0;
  const close = onceAsync(async () => {
    calls += 1;
  });

  await close();
  await close();
  await Promise.all([close(), close()]);

  assert.equal(calls, 1);
});

test('onceAsync retries after failure', async () => {
  let calls = 0;
  const close = onceAsync(async () => {
    calls += 1;
    if (calls === 1) {
      throw new Error('first-close-fails');
    }
  });

  await assert.rejects(() => close(), /first-close-fails/);
  await close();

  assert.equal(calls, 2);
});
