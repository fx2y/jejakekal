import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRetrievalBundleSidecars } from '../src/export/retrieval-sidecars.mjs';

test('retrieval export sidecars: sanitize provenance-only candidates and drop raw text', () => {
  const sidecars = buildRetrievalBundleSidecars([
    {
      function_name: 'retrieve',
      output: {
        retrieval: {
          query: 'invoice alpha',
          candidates: [
            {
              doc_id: 'doc-a',
              ver: 2,
              block_id: 'b1',
              rank: 1.23,
              rrf_score: 0.4,
              lane: ['vector', 'lexical', 'vector'],
              lane_reasons: [{ lane: 'lexical', rank_pos: 1, lane_rank: 0.9, internal: 'drop-me' }],
              cite: { doc_version: 2, page: 1, bbox: [0, 0, 1, 1], block_hash: 'ab', block_id: 'b1', extra: 'drop' },
              type: 'text',
              text: 'should not leak',
              snippet: 'also should not leak'
            },
            {
              doc_id: 'doc-b',
              ver: 3,
              block_id: 'b2',
              rank: 'not-a-number',
              cite: { doc_version: 3, page: 1 }
            }
          ]
        }
      }
    }
  ]);

  assert.deepEqual(sidecars?.retrieval_summary, {
    retrieval_events: 1,
    candidate_count: 1
  });
  assert.equal(Array.isArray(sidecars?.retrieval_results?.retrieval), true);
  assert.equal(sidecars?.retrieval_results?.retrieval?.[0]?.candidates?.length, 1);
  const candidate = sidecars?.retrieval_results?.retrieval?.[0]?.candidates?.[0];
  assert.deepEqual(candidate, {
    doc_id: 'doc-a',
    ver: 2,
    block_id: 'b1',
    rank: 1.23,
    rrf_score: 0.4,
    lane: ['lexical', 'vector'],
    lane_reasons: [{ lane: 'lexical', rank_pos: 1, lane_rank: 0.9 }],
    cite: { doc_version: 2, page: 1, bbox: [0, 0, 1, 1], block_hash: 'ab', block_id: 'b1' },
    type: 'text'
  });
  assert.equal(Object.hasOwn(candidate, 'text'), false);
  assert.equal(Object.hasOwn(candidate, 'snippet'), false);
});
