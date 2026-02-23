import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveBlockId, normalizeMarkerToBlocks } from '../src/docir.mjs';

test('C4 docir normalizer is deterministic for identical marker payloads', () => {
  const markerJson = {
    version: 'marker-stub-1.0.0',
    blocks: [
      { id: 'b-000', page: 1, type: 'text', text: 'invoice line item', bbox: [0, 0, 100, 20] },
      { id: 'b-001', page: 2, type: 'table', text: 'sku | qty | amount', bbox: [1, 2, 3, 4] }
    ]
  };
  const first = normalizeMarkerToBlocks({ docId: 'doc-abc', version: 1, markerJson });
  const second = normalizeMarkerToBlocks({ docId: 'doc-abc', version: 1, markerJson });
  assert.deepEqual(first, second);
  assert.equal(first.length, 2);
  assert.equal(first[0].type, 'text');
  assert.equal(first[1].type, 'table');
  assert.equal(first[0].block_id.length, 24);
  assert.equal(first[0].block_sha.length, 64);
});

test('C4 block id uses deterministic tuple doc/ver/page/type/content-sha', () => {
  const idA = deriveBlockId('doc-1', 2, 3, 'figure', 'a'.repeat(64));
  const idB = deriveBlockId('doc-1', 2, 3, 'figure', 'a'.repeat(64));
  const idC = deriveBlockId('doc-1', 2, 4, 'figure', 'a'.repeat(64));
  assert.equal(idA, idB);
  assert.notEqual(idA, idC);
  assert.equal(idA.length, 24);
});
