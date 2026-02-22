import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestDocument } from '../src/ingest.mjs';

test('smoke ingest writes raw/docir/chunks/memo with deterministic ordering', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'ingest-'));
  try {
    const first = await ingestDocument({ docId: 'doc1', source: 'x\ny', outDir });
    const second = await ingestDocument({ docId: 'doc1', source: 'x\ny', outDir });

    assert.equal(first.memo.chunkCount, 2);
    assert.deepEqual(first.memo.deterministicOrder, second.memo.deterministicOrder);

    const memo = JSON.parse(await readFile(first.paths.memo, 'utf8'));
    assert.equal(memo.ocrRequired, false);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
