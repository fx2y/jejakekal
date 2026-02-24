/**
 * @typedef {{index:number,text:string,confidence:number}} Page
 */
export { deriveBlockId, deriveTableId, normalizeMarkerToBlocks } from './docir/normalize-marker.mjs';

/**
 * @param {string} source
 * @returns {{pages: Page[]}}
 */
export function parseToDocIR(source) {
  const lines = source.split(/\r?\n/).filter(Boolean);
  const pages = lines.map((text, index) => {
    const confidence = text.includes('[low]') ? 0.4 : 0.95;
    return { index, text: text.replace('[low]', '').trim(), confidence };
  });
  return { pages };
}

/**
 * @param {{pages: Page[]}} doc
 * @param {number} threshold
 */
export function routeNeedsOCR(doc, threshold = 0.6) {
  return doc.pages.some((page) => page.confidence < threshold);
}

/**
 * @param {{pages: Page[]}} doc
 */
export function buildChunkIndex(doc) {
  return doc.pages.map((page) => ({
    chunkId: `chunk-${page.index.toString().padStart(3, '0')}`,
    page: page.index,
    text: page.text,
    confidence: page.confidence
  }));
}
