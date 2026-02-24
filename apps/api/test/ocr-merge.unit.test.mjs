import test from 'node:test';
import assert from 'node:assert/strict';
import { computeOcrMergePlan } from '../src/ocr/merge-core.mjs';

function markerBlock(overrides) {
  return {
    block_id: overrides.block_id,
    type: overrides.type,
    page: overrides.page,
    bbox: null,
    text: overrides.text ?? null,
    data: overrides.data ?? {},
    block_sha: overrides.block_sha
  };
}

test('ocr merge: replaces gated page text/table while preserving non-gated + figure blocks', () => {
  const plan = computeOcrMergePlan({
    docId: 'doc-1',
    version: 2,
    hardPages: [0],
    currentBlocks: [
      markerBlock({
        block_id: 'm-1',
        type: 'text',
        page: 1,
        text: 'marker text',
        block_sha: 'a'.repeat(64)
      }),
      markerBlock({
        block_id: 'm-2',
        type: 'table',
        page: 1,
        text: 'marker table',
        block_sha: 'b'.repeat(64)
      }),
      markerBlock({
        block_id: 'm-3',
        type: 'figure',
        page: 1,
        block_sha: 'c'.repeat(64)
      }),
      markerBlock({
        block_id: 'm-4',
        type: 'text',
        page: 2,
        text: 'marker page 2',
        block_sha: 'd'.repeat(64)
      })
    ],
    patches: [
      {
        page_idx: 0,
        patch: {
          text_md: 'ocr replacement',
          tables: [{ headers: ['h1'], rows: [['v1']] }]
        }
      }
    ]
  });

  assert.deepEqual(plan.merged_pages, [0]);
  assert.equal(plan.replacement_blocks.some((row) => row.type === 'text' && row.page === 1), true);
  assert.equal(plan.replacement_blocks.some((row) => row.type === 'table' && row.page === 1), true);
  assert.equal(
    plan.replacement_blocks.some((row) => row.type === 'text' && row.text === 'marker page 2'),
    false
  );
  assert.equal(plan.page_diffs.length, 1);
  assert.equal(plan.page_diffs[0].changed_blocks > 0, true);
  assert.equal(typeof plan.diff_sha, 'string');
  assert.equal(plan.diff_sha.length, 64);
});

test('ocr merge: deterministic summary hash for identical inputs', () => {
  const input = {
    docId: 'doc-2',
    version: 1,
    hardPages: [1, 0],
    currentBlocks: [
      markerBlock({
        block_id: 'x-1',
        type: 'text',
        page: 1,
        text: 'one',
        block_sha: '1'.repeat(64)
      }),
      markerBlock({
        block_id: 'x-2',
        type: 'text',
        page: 2,
        text: 'two',
        block_sha: '2'.repeat(64)
      })
    ],
    patches: [
      {
        page_idx: 0,
        patch: {
          text_md: 'ocr one'
        }
      },
      {
        page_idx: 1,
        patch: {
          text_md: 'ocr two'
        }
      }
    ]
  };
  const a = computeOcrMergePlan(input);
  const b = computeOcrMergePlan(input);
  assert.deepEqual(a, b);
});
