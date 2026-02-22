import test from 'node:test';
import assert from 'node:assert/strict';
import { assertValidArtifactId, decodeAndValidateArtifactId } from '../src/artifacts/artifact-id.mjs';

test('artifact-id: accepts allowlisted ids', () => {
  assert.equal(assertValidArtifactId('run-1:raw'), 'run-1:raw');
  assert.equal(decodeAndValidateArtifactId('chunk-index'), 'chunk-index');
});

test('artifact-id: rejects malformed/encoded traversal ids with typed 400', () => {
  assert.throws(() => decodeAndValidateArtifactId('%2E%2E'), {
    name: 'RequestError',
    payload: { error: 'invalid_artifact_id', field: 'artifact_id' }
  });
  assert.throws(() => assertValidArtifactId('../x', 'artifact_id'), {
    name: 'RequestError',
    payload: { error: 'invalid_artifact_id', field: 'artifact_id' }
  });
});
