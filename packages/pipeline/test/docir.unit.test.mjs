import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChunkIndex, parseToDocIR, routeNeedsOCR } from '../src/docir.mjs';

test('docir parser and confidence gate are deterministic', () => {
  const source = 'a\nb [low]\nc';
  const doc = parseToDocIR(source);
  assert.equal(doc.pages.length, 3);
  assert.equal(routeNeedsOCR(doc), true);

  const chunksA = buildChunkIndex(doc);
  const chunksB = buildChunkIndex(doc);
  assert.deepEqual(chunksA, chunksB);
  assert.equal(chunksA[1].chunkId, 'chunk-001');
});
