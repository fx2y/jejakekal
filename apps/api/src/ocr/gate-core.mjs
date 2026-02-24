import { sha256 } from '../../../../packages/core/src/hash.mjs';

const DEFAULT_GATE_CONFIG = Object.freeze({
  threshold: 0.9,
  maxPages: 10
});

const GATE_ALGO_REV = 'c1-gate-v1';

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {number} fallback
 */
function toPageIdx0(value, fallback) {
  const page = Number(value);
  if (!Number.isFinite(page)) return fallback;
  return Math.max(0, Math.trunc(page) - 1);
}

/**
 * @param {unknown} value
 */
function toFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

/**
 * @param {unknown} value
 */
function toNonEmptyText(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > 0 ? text : '';
}

/**
 * @param {unknown} markerJson
 * @returns {Array<{idx:number, blocks:Array<Record<string, unknown>>}>}
 */
function extractPages(markerJson) {
  if (Array.isArray(markerJson)) {
    return markerJson.map((entry, idx) => ({
      idx,
      blocks: isRecord(entry) ? [entry] : []
    }));
  }
  if (isRecord(markerJson) && Array.isArray(markerJson.blocks)) {
    /** @type {Map<number, Array<Record<string, unknown>>>} */
    const byPage = new Map();
    markerJson.blocks.forEach((entry, idx) => {
      if (!isRecord(entry)) return;
      const pageIdx = toPageIdx0(entry.page, idx);
      if (!byPage.has(pageIdx)) byPage.set(pageIdx, []);
      byPage.get(pageIdx)?.push(entry);
    });
    const sortedPages = [...byPage.keys()].sort((a, b) => a - b);
    return sortedPages.map((idx) => ({ idx, blocks: byPage.get(idx) ?? [] }));
  }
  if (isRecord(markerJson) && Array.isArray(markerJson.children)) {
    return markerJson.children.map((entry, idx) => ({
      idx,
      blocks: isRecord(entry) ? [entry] : []
    }));
  }
  return [];
}

/**
 * @param {Array<Record<string, unknown>>} blocks
 */
function scorePage(blocks) {
  let blockCount = 0;
  let textChars = 0;
  let imageLike = 0;
  let tableLike = 0;
  let shortText = 0;
  const reasons = [];
  for (const block of blocks) {
    blockCount += 1;
    const type = String(block.type ?? block.block_type ?? '').trim().toLowerCase();
    const text = toNonEmptyText(block.text);
    textChars += text.length;
    if (text.length > 0 && text.length < 16) shortText += 1;
    if (type === 'figure' || type === 'image') imageLike += 1;
    if (type === 'table') tableLike += 1;
  }
  let score = 0;
  if (blockCount === 0) {
    score += 1;
    reasons.push('no_blocks');
  }
  if (textChars < 40) {
    score += 0.7;
    reasons.push('low_text_density');
  }
  if (imageLike > 0 && textChars < 80) {
    score += 0.4;
    reasons.push('image_heavy');
  }
  if (blockCount >= 3 && shortText >= Math.max(3, Math.floor(blockCount * 0.6))) {
    score += 0.3;
    reasons.push('fragmented_short_blocks');
  }
  if (tableLike > 0 && textChars < Math.max(24, tableLike * 16)) {
    score += 0.2;
    reasons.push('table_low_text');
  }
  if (reasons.length === 0) {
    reasons.push('marker_ok');
  }
  return {
    score: Math.round(score * 1_000_000) / 1_000_000,
    reasons
  };
}

/**
 * @param {unknown} gateCfg
 */
function normalizeGateConfig(gateCfg) {
  const source = isRecord(gateCfg) ? gateCfg : {};
  const threshold = toFiniteNumber(source.threshold);
  const maxPages = Math.max(1, Math.trunc(toFiniteNumber(source.maxPages || source.max_pages)));
  return Object.freeze({
    threshold: threshold > 0 ? threshold : DEFAULT_GATE_CONFIG.threshold,
    maxPages: maxPages > 0 ? maxPages : DEFAULT_GATE_CONFIG.maxPages
  });
}

/**
 * @param {unknown} markerJson
 * @param {unknown} gateCfg
 */
export function computeHardPages(markerJson, gateCfg) {
  const cfg = normalizeGateConfig(gateCfg);
  const pages = extractPages(markerJson);
  const scoreByPage = pages.map(() => 0);
  /** @type {Record<string, string[]>} */
  const reasons = {};
  const scored = pages.map((page, pageOrder) => {
    const { score, reasons: pageReasons } = scorePage(page.blocks);
    scoreByPage[pageOrder] = score;
    reasons[String(pageOrder)] = [...new Set(pageReasons)].sort((a, b) => a.localeCompare(b));
    const hard = score >= cfg.threshold || reasons[String(pageOrder)].includes('no_blocks');
    return { pageOrder, score, hard };
  });
  const hardPages = scored
    .filter((page) => page.hard)
    .sort((a, b) => b.score - a.score || a.pageOrder - b.pageOrder)
    .slice(0, cfg.maxPages)
    .map((page) => page.pageOrder)
    .sort((a, b) => a - b);
  const code_rev = sha256(
    JSON.stringify({
      algo: GATE_ALGO_REV,
      threshold: cfg.threshold,
      max_pages: cfg.maxPages
    })
  );
  const gate_rev = sha256(
    JSON.stringify({
      code_rev,
      pages: pages.length,
      hard_pages: hardPages,
      score_by_page: scoreByPage,
      reasons
    })
  );
  return {
    gate_rev,
    code_rev,
    hard_pages: hardPages,
    score_by_page: scoreByPage,
    reasons
  };
}

