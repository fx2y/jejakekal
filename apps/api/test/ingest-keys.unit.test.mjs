import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertAllowedObjectKey,
  buildAssetObjectKey,
  buildParseObjectKey,
  buildRawObjectKey,
  buildRunObjectKey,
  makeRunArtifactId
} from '../src/ingest/keys.mjs';

test('ingest keys: deterministic key builders produce canonical prefixes', () => {
  assert.equal(buildRawObjectKey('a'.repeat(64)), `raw/sha256/${'a'.repeat(64)}`);
  assert.equal(
    buildParseObjectKey({ docId: 'doc-1', version: 2, filename: 'marker.json' }),
    'parse/doc-1/2/marker.json'
  );
  assert.equal(buildAssetObjectKey('b'.repeat(64)), `asset/sha256/${'b'.repeat(64)}`);
  assert.equal(buildRunObjectKey({ runId: 'run-1', relativePath: 'artifact/memo.md' }), 'run/run-1/artifact/memo.md');
  assert.equal(
    buildRunObjectKey({ runId: 'WF:RUN-01', relativePath: 'artifact/memo.md' }),
    'run/WF:RUN-01/artifact/memo.md'
  );
});

test('ingest keys: prefix and segment validation fail closed', () => {
  assert.throws(() => buildRawObjectKey('xyz'), { message: 'raw_sha256_invalid' });
  assert.throws(
    () => buildParseObjectKey({ docId: '../bad', version: 1, filename: 'marker.json' }),
    { message: 'doc_id_invalid' }
  );
  assert.throws(() => buildParseObjectKey({ docId: 'doc', version: 1, filename: 'bad.json' }), {
    message: 'parse_filename_invalid'
  });
  assert.throws(() => assertAllowedObjectKey('misc/key'), { message: 'object_key_invalid' });
  assert.equal(assertAllowedObjectKey('raw/sha256/abc'), 'raw/sha256/abc');
});

test('ingest keys: run artifact id remains valid for max-length run ids', () => {
  const longRunId = `WF:${'A'.repeat(125)}`;
  const artifactId = makeRunArtifactId(longRunId, 'memo');
  assert.ok(artifactId.length <= 128);
  assert.equal(artifactId.endsWith(':memo'), true);
});
