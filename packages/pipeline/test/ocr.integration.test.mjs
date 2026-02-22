import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestDocument } from '../src/ingest.mjs';

test('low confidence pages route through OCR gate when enabled', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'ocr-'));
  try {
    const result = await ingestDocument({ docId: 'doc-ocr', source: 'ok\nneeds [low] ocr', outDir, useOCR: true });
    assert.equal(result.memo.ocrRequired, true);
    assert.equal(result.memo.ocrUsed, true);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
