import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveDocId,
  MARKER_CONFIG_PLACEHOLDER_SHA
} from '../src/ingest/doc-repository.mjs';

test('deriveDocId is deterministic and constrained', () => {
  const rawSha = 'a'.repeat(64);
  assert.equal(deriveDocId(rawSha), `doc-${'a'.repeat(24)}`);
  assert.throws(() => deriveDocId('bad'), /invalid_raw_sha/);
});

test('marker config placeholder hash is stable sha256', () => {
  assert.equal(typeof MARKER_CONFIG_PLACEHOLDER_SHA, 'string');
  assert.equal(MARKER_CONFIG_PLACEHOLDER_SHA.length, 64);
  assert.match(MARKER_CONFIG_PLACEHOLDER_SHA, /^[a-f0-9]{64}$/);
});
