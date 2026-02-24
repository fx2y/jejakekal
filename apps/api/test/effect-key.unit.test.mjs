import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIngestEffectKey, buildOcrPageRenderEffectKey } from '../src/ingest/effect-key.mjs';

test('effect keys: ingest and OCR page render keys are deterministic and typed', () => {
  const ingest = buildIngestEffectKey({
    workflowId: 'wf-effect',
    step: 'store-raw',
    docId: 'doc-1',
    version: 1,
    sha256: 'a'.repeat(64)
  });
  assert.equal(ingest, `wf-effect|store-raw|doc-1|1|${'a'.repeat(64)}`);

  const ocr = buildOcrPageRenderEffectKey({
    workflowId: 'wf-effect',
    docId: 'doc-1',
    version: 2,
    pageIdx: 3,
    pngSha256: 'b'.repeat(64)
  });
  assert.equal(ocr, `wf-effect|ocr-render-page|doc-1|2|p3|${'b'.repeat(64)}`);
});

test('effect keys: OCR render page key fails closed on bad inputs', () => {
  assert.throws(
    () =>
      buildOcrPageRenderEffectKey({
        workflowId: 'wf-effect',
        docId: 'doc-1',
        version: 2,
        pageIdx: -1,
        pngSha256: 'b'.repeat(64)
      }),
    { message: 'page_idx_invalid' }
  );
  assert.throws(
    () =>
      buildOcrPageRenderEffectKey({
        workflowId: 'wf-effect',
        docId: 'doc-1',
        version: 2,
        pageIdx: 0,
        pngSha256: 'bad'
      }),
    { message: 'effect_sha256_invalid' }
  );
});
