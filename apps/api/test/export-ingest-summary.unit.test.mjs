import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIngestManifestSummary } from '../src/export/ingest-summary.mjs';

test('ingest summary builder maps workflow step outputs additively', () => {
  const summary = buildIngestManifestSummary([
    {
      function_name: 'reserve-doc',
      output: { doc_id: 'doc-x', ver: 3, raw_sha: 'a'.repeat(64) }
    },
    {
      function_name: 'store-raw',
      output: { key: 'raw/sha256/a' }
    },
    {
      function_name: 'marker-convert',
      output: { chunk_count: 7 }
    },
    {
      function_name: 'store-parse-outputs',
      output: {
        parse_keys: ['parse/doc-x/3/chunks.json', 'parse/doc-x/3/marker.json'],
        asset_keys: ['asset/sha256/b'],
        asset_count: 1,
        marker_timing_ms: 42,
        marker_stderr_sha: 'c'.repeat(64)
      }
    },
    {
      function_name: 'normalize-docir',
      output: { block_count: 11 }
    },
    {
      function_name: 'index-fts',
      output: { indexed: 11 }
    }
  ]);

  assert.deepEqual(summary.keys.parse, ['parse/doc-x/3/chunks.json', 'parse/doc-x/3/marker.json']);
  assert.deepEqual(summary.keys.assets, ['asset/sha256/b']);
  assert.equal(summary.doc_id, 'doc-x');
  assert.equal(summary.ver, 3);
  assert.equal(summary.raw_sha, 'a'.repeat(64));
  assert.equal(summary.counts.blocks, 11);
  assert.equal(summary.counts.chunk_index, 7);
  assert.equal(summary.counts.assets, 1);
  assert.equal(summary.counts.fts_indexed, 11);
  assert.equal(summary.timing_ms.marker, 42);
  assert.equal(summary.stderr_ref, 'c'.repeat(64));
});
