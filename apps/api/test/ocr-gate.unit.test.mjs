import test from 'node:test';
import assert from 'node:assert/strict';
import { computeHardPages } from '../src/ocr/gate-core.mjs';

function buildMarkerFixture() {
  return {
    version: 'marker-stub-1.0.0',
    blocks: [
      { page: 1, type: 'text', text: 'tiny' },
      { page: 1, type: 'image', text: '' },
      { page: 2, type: 'text', text: 'This page is rich text and should not be gated by default threshold.' },
      { page: 2, type: 'text', text: 'Additional body text keeps density high and stable.' },
      { page: 3, type: 'table', text: 'a|b' },
      { page: 4, type: 'image', text: '' }
    ]
  };
}

test('ocr gate: deterministic snapshot for identical marker payload', () => {
  const markerJson = buildMarkerFixture();
  const first = computeHardPages(markerJson, { threshold: 0.9, maxPages: 3 });
  const second = computeHardPages(markerJson, { threshold: 0.9, maxPages: 3 });
  assert.deepEqual(first, second);
  assert.equal(first.score_by_page.length, 4);
  assert.deepEqual(first.hard_pages, [0, 2, 3]);
  assert.equal(first.gate_rev.length, 64);
  assert.equal(first.code_rev.length, 64);
  assert.deepEqual(first.reasons['1'], ['marker_ok']);
});

test('ocr gate: stable score ordering + deterministic cap', () => {
  const markerJson = buildMarkerFixture();
  const capped = computeHardPages(markerJson, { threshold: 0.7, maxPages: 2 });
  assert.deepEqual(capped.hard_pages, [0, 3]);
  assert.ok(capped.score_by_page[0] >= capped.score_by_page[2]);
  assert.ok(capped.score_by_page[3] >= capped.score_by_page[2]);
});

test('ocr gate: sparse marker page numbers keep original 0-based index mapping', () => {
  const sparse = computeHardPages(
    {
      blocks: [
        { page: 1, type: 'text', text: 'x'.repeat(64) },
        { page: 3, type: 'image', text: '' }
      ]
    },
    { threshold: 0.9, maxPages: 10 }
  );
  assert.deepEqual(sparse.hard_pages, [2]);
  assert.equal(typeof sparse.score_by_page[2], 'number');
  assert.deepEqual(sparse.reasons['2'], ['image_heavy', 'low_text_density']);
});
