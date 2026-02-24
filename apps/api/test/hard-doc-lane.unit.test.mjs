import test from 'node:test';
import assert from 'node:assert/strict';
import { runHardDocFallbackLane } from '../src/ocr/hard-doc-lane.mjs';

test('hard-doc lane seam: stub path is deterministic marker-only no-op', async () => {
  const first = await runHardDocFallbackLane({ markerJson: [{ id: 'p0' }] });
  const second = await runHardDocFallbackLane({ markerJson: [{ id: 'p0' }] });
  assert.deepEqual(first, second);
  assert.deepEqual(first, {
    gate: {
      gate_rev: 'c0-gate-stub-v1',
      hard_pages: [],
      score_by_page: [0],
      reasons: {}
    },
    rendered_pages: [],
    ocr_pages: [],
    merge: { merged_pages: [], diff_sha: null }
  });
});
