/**
 * @param {{hard_pages:number[]}} params
 */
export async function runOcrRenderSeam(params) {
  const pages = [...new Set((params.hard_pages ?? []).map((page) => Math.max(0, Math.trunc(page))))].sort(
    (a, b) => a - b
  );
  return {
    pages: pages.map((page_idx) => ({ page_idx, png_uri: null, png_sha: null }))
  };
}
