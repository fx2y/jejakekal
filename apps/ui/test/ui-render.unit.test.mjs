import test from 'node:test';
import assert from 'node:assert/strict';
import { renderArtifactsPane, renderExecutionPane } from '../src/ui-render.mjs';

test('renderExecutionPane: includes additive OCR metadata in timeline rows', () => {
  const html = renderExecutionPane(
    {
      run_id: 'r-ocr',
      status: 'running',
      timeline: [
        {
          function_id: 5,
          function_name: 'ocr-persist-gate',
          output: {
            hard_pages: [1, 3],
            reasons: {
              '1': ['image_only'],
              '3': ['table_quality_low', 'low_text_density']
            }
          }
        },
        {
          function_id: 7,
          function_name: 'ocr-pages',
          output: {
            ocr_pages: [{ page_idx: 1 }, { page_idx: 3 }],
            ocr_failures: 0,
            ocr_model: 'zai-org/GLM-OCR'
          }
        }
      ]
    },
    {}
  );
  assert.equal(html.includes('hard_pages=2'), true);
  assert.equal(html.includes('gate_reason_count=3'), true);
  assert.equal(html.includes('ocr_pages=2'), true);
  assert.equal(html.includes('ocr_failures=0'), true);
  assert.equal(html.includes('ocr_model=zai-org/GLM-OCR'), true);
});

test('renderArtifactsPane: producer_function_id keeps run deep-link step query', () => {
  const html = renderArtifactsPane(
    [
      {
        id: 'r1:memo',
        run_id: 'r1',
        type: 'memo',
        status: 'ready',
        visibility: 'user',
        created_at: '2026-02-24T00:00:00.000Z',
        prov: { producer_function_id: 8 }
      }
    ],
    {}
  );
  assert.equal(html.includes('/runs/r1?step=8'), true);
});
