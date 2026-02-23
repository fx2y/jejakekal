import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeBundleArtifactUri,
  parseArtifactUri,
  parseArtifactUriScheme,
  parseBundleArtifactUri,
  parseS3ArtifactUri,
  resolveArtifactUriToPath,
  resolveBundleArtifactUri
} from '../src/artifact-uri.mjs';

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

test('artifact-uri: scheme parser allows bundle + s3 only', () => {
  assert.equal(parseArtifactUriScheme('bundle://run-123/memo/ingest/memo.md'), 'bundle');
  assert.equal(parseArtifactUriScheme('s3://mem/raw/sha256/abcd'), 's3');
  assert.throws(() => parseArtifactUriScheme('http://example.com/raw'), {
    message: 'invalid_artifact_uri'
  });
});

test('artifact-uri: parse s3 uri keeps strict key parsing', () => {
  assert.deepEqual(parseS3ArtifactUri('s3://mem/raw/sha256/abcd'), {
    bucket: 'mem',
    key: 'raw/sha256/abcd'
  });
  assert.deepEqual(parseArtifactUri('s3://mem/raw/sha256/abcd'), {
    scheme: 's3',
    bucket: 'mem',
    key: 'raw/sha256/abcd'
  });
});

test('artifact-uri: generic resolver handles bundle and fail-closed s3 by default', () => {
  assert.equal(
    resolveArtifactUriToPath('/tmp/bundles', 'bundle://run-123/memo/ingest/memo.md'),
    '/tmp/bundles/run-123/ingest/memo.md'
  );
  assert.throws(() => resolveArtifactUriToPath('/tmp/bundles', 's3://mem/raw/sha256/abcd'), {
    message: 'artifact_uri_scheme_not_supported'
  });
});
