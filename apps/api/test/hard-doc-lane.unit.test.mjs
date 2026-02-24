import test from 'node:test';
import assert from 'node:assert/strict';
import { runHardDocFallbackLane } from '../src/ocr/hard-doc-lane.mjs';

test('hard-doc lane seam: injected empty gate short-circuits render/ocr/merge', async () => {
  const seams = {
    gate: async () => ({
      gate_rev: 'gate-empty',
      code_rev: 'code-empty',
      hard_pages: [],
      score_by_page: [0],
      reasons: { '0': ['marker_ok'] }
    })
  };
  const first = await runHardDocFallbackLane({ markerJson: [{ id: 'p0' }] }, seams);
  const second = await runHardDocFallbackLane({ markerJson: [{ id: 'p0' }] }, seams);
  assert.deepEqual(first, second);
  assert.deepEqual(first, {
    gate: {
      gate_rev: 'gate-empty',
      code_rev: 'code-empty',
      hard_pages: [],
      score_by_page: [0],
      reasons: { '0': ['marker_ok'] }
    },
    rendered_pages: [],
    ocr_pages: [],
    merge: { merged_pages: [], diff_sha: null }
  });
});
