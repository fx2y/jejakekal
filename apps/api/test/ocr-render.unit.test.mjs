import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runMarker } from '../../../packages/pipeline/src/marker/runner.mjs';
import { assertPdfRenderDependency, renderPdfPages, toPageIdx0, toPdfPageIndex } from '../src/ocr/pdf-render.mjs';
import { runOcrRenderSeam } from '../src/ocr/render-seam.mjs';

test('ocr render: 0-based <-> 1-based page translators are exact inverses', () => {
  assert.equal(toPdfPageIndex(0), 1);
  assert.equal(toPdfPageIndex(4), 5);
  assert.equal(toPageIdx0(1), 0);
  assert.equal(toPageIdx0(8), 7);
});

test('ocr render: dependency check fails closed for missing pdftoppm binary', async () => {
  await assert.rejects(() => assertPdfRenderDependency({ pdftoppmBin: 'pdftoppm-missing-bin' }), {
    message: 'ocr_render_missing_pdftoppm'
  });
});

test('ocr render: pdftoppm renders requested page indexes deterministically', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'ocr-render-unit-'));
  try {
    const marker = await runMarker({
      source: 'first-page\nsecond-page\nthird-page',
      outDir
    });
    const rendered = await renderPdfPages({
      pdfPath: marker.paths.sourcePdf,
      pageIdx0: [2, 0, 2]
    });
    assert.deepEqual(
      rendered.map((row) => row.page_idx),
      [0, 2]
    );
    assert.ok(rendered.every((row) => Buffer.isBuffer(row.png) && row.png.length > 8));
    assert.ok(rendered.every((row) => typeof row.png_sha === 'string' && row.png_sha.length === 64));
    assert.notEqual(rendered[0].png_sha, rendered[1].png_sha);

    const seam = await runOcrRenderSeam({
      hard_pages: [2, 0, 2],
      pdf_path: marker.paths.sourcePdf
    });
    assert.deepEqual(
      seam.pages.map((row) => row.page_idx),
      [0, 2]
    );
    assert.ok(seam.pages.every((row) => typeof row.png_sha === 'string'));
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('ocr render seam: hard pages fail closed when source PDF is missing', async () => {
  await assert.rejects(
    () =>
      runOcrRenderSeam({
        hard_pages: [0]
      }),
    {
      message: 'ocr_render_source_pdf_missing'
    }
  );
});
