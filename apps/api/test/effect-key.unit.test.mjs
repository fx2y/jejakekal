import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIngestEffectKey } from '../src/ingest/effect-key.mjs';

test('effect-key: deterministic workflow:step:doc:ver:sha identity', () => {
  const key = buildIngestEffectKey({
    workflowId: 'WF:RUN-1',
    step: 'store-raw',
    docId: 'doc-abc',
    version: 2,
    sha256: 'a'.repeat(64)
  });
  assert.equal(key, `WF:RUN-1|store-raw|doc-abc|2|${'a'.repeat(64)}`);
});

test('effect-key: invalid digests fail closed', () => {
  assert.throws(
    () =>
      buildIngestEffectKey({
        workflowId: 'wf-1',
        step: 'store-raw',
        docId: 'doc-abc',
        version: 1,
        sha256: 'not-sha'
      }),
    { message: 'effect_sha256_invalid' }
  );
});
