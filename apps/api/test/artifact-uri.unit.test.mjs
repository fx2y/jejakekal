import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBundleArtifactUri, parseBundleArtifactUri, resolveBundleArtifactUri } from '../src/artifact-uri.mjs';

test('artifact-uri: canonical bundle uri roundtrip', () => {
  const uri = makeBundleArtifactUri({
    runId: 'run-123',
    artifactId: 'memo',
    relativePath: 'ingest/memo.md'
  });
  assert.equal(uri, 'bundle://run-123/memo/ingest/memo.md');
  assert.deepEqual(parseBundleArtifactUri(uri), {
    runId: 'run-123',
    artifactId: 'memo',
    relativePath: 'ingest/memo.md'
  });
});

test('artifact-uri: resolve stays under bundles root', () => {
  const safe = resolveBundleArtifactUri('/tmp/bundles', 'bundle://run-123/memo/ingest/memo.md');
  assert.equal(safe, '/tmp/bundles/run-123/ingest/memo.md');
});

test('artifact-uri: traversal in relative path is rejected', () => {
  assert.throws(() => parseBundleArtifactUri('bundle://run-123/memo/ingest/../memo.md'), {
    message: 'invalid_artifact_uri'
  });
});
