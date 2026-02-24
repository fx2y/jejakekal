import { renderPdfPages } from './pdf-render.mjs';

/**
 * @param {unknown} value
 */
function toPageIdx0(value) {
  const page = Number(value);
  if (!Number.isFinite(page)) return null;
  return Math.max(0, Math.trunc(page));
}

/**
 * @param {{hard_pages:number[], pdf_path?: string}} params
 */
export async function runOcrRenderSeam(params) {
  const pages = [...new Set((params.hard_pages ?? []).map((page) => toPageIdx0(page)).filter((page) => page != null))].sort((a, b) => a - b);
  if (!params.pdf_path || pages.length < 1) {
    return {
      pages: pages.map((page_idx) => ({ page_idx, png: null, png_sha: null, mime: null }))
    };
  }
  const rendered = await renderPdfPages({
    pdfPath: params.pdf_path,
    pageIdx0: pages
  });
  return {
    pages: rendered.map((entry) => ({
      page_idx: entry.page_idx,
      png: entry.png,
      png_sha: entry.png_sha,
      mime: entry.mime
    }))
  };
}
