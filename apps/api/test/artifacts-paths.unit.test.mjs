import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeArtifactDownloadRouteId,
  decodeArtifactRouteId
} from '../src/routes/artifacts-paths.mjs';

test('artifacts-paths: decode artifact id and download id', () => {
  assert.equal(decodeArtifactRouteId('/artifacts/run-1:raw'), 'run-1:raw');
  assert.equal(
    decodeArtifactDownloadRouteId('/artifacts/run-1:raw/download'),
    'run-1:raw'
  );
});

test('artifacts-paths: rejects non-matching path shapes', () => {
  assert.equal(decodeArtifactRouteId('/artifacts/run-1:raw/download'), null);
  assert.equal(decodeArtifactDownloadRouteId('/artifacts/run-1:raw'), null);
});
