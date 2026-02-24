import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExecMemoMarkdown } from '../src/ingest/exec-memo.mjs';

test('exec memo builder emits deterministic markdown with block refs', () => {
  const markdown = buildExecMemoMarkdown({
    docId: 'doc-abc',
    version: 2,
    rawSha: 'a'.repeat(64),
    markerConfigSha: 'b'.repeat(64),
    blocks: [
      {
        block_id: '0123456789abcdef01234567',
        type: 'text',
        page: 1,
        text: '  hello   world  ',
        data: {}
      },
      {
        block_id: 'abcdef0123456789abcdef01',
        type: 'table',
        page: 2,
        text: null,
        data: { title: 'table title' }
      }
    ],
    ocr: {
      hard_pages: [0, 2],
      ocr_pages: [2],
      diff_sha: 'c'.repeat(64)
    }
  });

  assert.equal(markdown.startsWith('# Exec memo: doc-abc v2\n'), true);
  assert.equal(markdown.includes('## Block counts'), true);
  assert.equal(markdown.includes('- text: 1'), true);
  assert.equal(markdown.includes('- table: 1'), true);
  assert.equal(markdown.includes('[b:0123456789abcdef01234567]'), true);
  assert.equal(markdown.includes('[b:abcdef0123456789abcdef01]'), true);
  assert.equal(markdown.includes('## OCR merge'), true);
  assert.equal(markdown.includes('- hard_pages: 0,2'), true);
  assert.equal(markdown.includes('- ocr_pages: 2'), true);
  assert.equal(markdown.includes(`- diff_sha: ${'c'.repeat(64)}`), true);
});
