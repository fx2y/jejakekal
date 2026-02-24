import test from 'node:test';
import assert from 'node:assert/strict';
import { execRows } from '../src/ui-view-model.mjs';

test('execRows: maps OCR gate and OCR page metadata additively', () => {
  const rows = execRows({
    run_id: 'r1',
    status: 'running',
    timeline: [
      {
        function_id: 5,
        function_name: 'ocr-persist-gate',
        output: {
          hard_pages: [2, 1],
          reasons: {
            '1': ['image_only', 'low_text_density'],
            '2': ['table_quality_low']
          }
        }
      },
      {
        function_id: 7,
        function_name: 'ocr-pages',
        output: {
          ocr_pages: [{ page_idx: 1 }, { page_idx: 2 }, { page_idx: 2 }],
          ocr_failures: 1,
          ocr_model: 'zai-org/GLM-OCR'
        }
      }
    ]
  });

  assert.equal(rows.length, 2);
  assert.equal(rows[0].hard_page_count, 2);
  assert.equal(rows[0].gate_reason_count, 3);
  assert.equal(rows[0].ocr_page_count, 0);
  assert.equal(rows[0].ocr_failures, null);
  assert.equal(rows[0].ocr_model, null);
  assert.equal(rows[1].hard_page_count, 0);
  assert.equal(rows[1].gate_reason_count, 0);
  assert.equal(rows[1].ocr_page_count, 2);
  assert.equal(rows[1].ocr_failures, 1);
  assert.equal(rows[1].ocr_model, 'zai-org/GLM-OCR');
});
