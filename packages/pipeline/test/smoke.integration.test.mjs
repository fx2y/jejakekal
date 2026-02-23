import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestDocument } from '../src/ingest.mjs';

test('C3 marker contract: ingest emits marker json/md/chunks/html/images deterministically', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'ingest-marker-'));
  try {
    const source = 'first row\na | b | c table';
    const first = await ingestDocument({ docId: 'doc1', source, outDir });
    const second = await ingestDocument({ docId: 'doc1', source, outDir });

    assert.equal(first.marker.mode, 'deterministic');
    assert.equal(first.memo.markerUseLlm, false);
    assert.deepEqual(first.memo.chunkCount, second.memo.chunkCount);

    const markerJson = JSON.parse(await readFile(first.paths.docir, 'utf8'));
    const markerChunks = JSON.parse(await readFile(first.paths.chunkIndex, 'utf8'));
    assert.equal(Array.isArray(markerJson.blocks), true);
    assert.equal(Array.isArray(markerChunks), true);
    assert.equal(markerJson.blocks.some((row) => row.type === 'table'), true);
    assert.equal(markerChunks.some((row) => row.type === 'table'), true);

    const markerMd = await readFile(first.paths.markerMd, 'utf8');
    assert.equal(markerMd.includes('# Marker Output'), true);
    const markerHtml = await readFile(first.paths.markerHtml, 'utf8');
    assert.equal(markerHtml.includes('<html>'), true);
    assert.equal(first.assets.length >= 1, true);
    assert.equal(typeof first.assets[0].sha256, 'string');
    assert.equal(first.assets[0].sha256.length, 64);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
