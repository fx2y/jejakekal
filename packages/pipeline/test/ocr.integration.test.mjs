import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestDocument } from '../src/ingest.mjs';

test('C3 hybrid toggle: default is deterministic and opt-in enables hybrid mode', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'ocr-'));
  try {
    const deterministic = await ingestDocument({ docId: 'doc-default', source: 'hello', outDir });
    assert.equal(deterministic.marker.use_llm, 0);
    assert.equal(deterministic.marker.mode, 'deterministic');

    const hybrid = await ingestDocument({ docId: 'doc-hybrid', source: 'hello', outDir, useLlm: true });
    assert.equal(hybrid.marker.use_llm, 1);
    assert.equal(hybrid.marker.mode, 'hybrid');
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
