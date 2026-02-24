import assert from 'node:assert/strict';
import test from 'node:test';
import { mapOperationOutputRow } from '../src/runs-projections.mjs';

test('runs-projections: timeline sanitizer strips source and local path-like keys recursively', () => {
  const row = mapOperationOutputRow({
    workflow_uuid: 'wf-1',
    function_id: 1,
    function_name: 'ocr-render',
    started_at_epoch_ms: 1000,
    completed_at_epoch_ms: 1100,
    output: JSON.stringify({
      json: {
        source: 'raw source text',
        sourcePdf: '/tmp/doc.pdf',
        source_pdf: '/tmp/doc-2.pdf',
        render_path: '/tmp/render',
        paths: { memo: '/tmp/memo.md' },
        chunkIndex: '/tmp/chunks.json',
        args: ['python', '/home/user/bin/tool.py', '--flag'],
        nested: {
          localPath: '/home/user/local',
          safe: 'ok',
          arr: [{ file_path: '/tmp/file-a' }, { note: 'keep' }]
        }
      }
    }),
    error: null
  });

  assert.equal(row.output.source, undefined);
  assert.equal(row.output.sourcePdf, undefined);
  assert.equal(row.output.source_pdf, undefined);
  assert.equal(row.output.render_path, undefined);
  assert.equal(row.output.paths, undefined);
  assert.equal(row.output.chunkIndex, undefined);
  assert.deepEqual(row.output.args, ['python', '--flag']);
  assert.equal(row.output.nested.localPath, undefined);
  assert.equal(row.output.nested.arr[0].file_path, undefined);
  assert.equal(row.output.nested.safe, 'ok');
  assert.equal(row.output.nested.arr[1].note, 'keep');
});
