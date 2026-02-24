import { sha256 } from '../../../../packages/core/src/hash.mjs';
import { deriveBlockId } from '../../../../packages/pipeline/src/docir/normalize-marker.mjs';

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} value
 */
function stableStringify(value) {
  if (value == null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (!isRecord(value)) {
    return JSON.stringify(String(value));
  }
  const keys = Object.keys(value).sort((a, b) => a.localeCompare(b));
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

/**
 * @param {unknown} value
 */
function asPageIdxSet(value) {
  const pages = Array.isArray(value) ? value : [];
  return new Set(
    pages
      .map((entry) => Number(entry))
      .filter((entry) => Number.isFinite(entry) && Number.isInteger(entry) && entry >= 0)
      .sort((a, b) => a - b)
  );
}

/**
 * @param {unknown} value
 */
function asPatchRows(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((row) => isRecord(row))
    .map((row) => ({
      page_idx: Number(row.page_idx),
      patch:
        isRecord(row.patch) && !Array.isArray(row.patch)
          ? /** @type {Record<string, unknown>} */ (row.patch)
          : {}
    }))
    .filter((row) => Number.isFinite(row.page_idx) && Number.isInteger(row.page_idx) && row.page_idx >= 0)
    .sort((a, b) => a.page_idx - b.page_idx);
}

/**
 * @param {unknown} value
 */
function asLedgerBlocks(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((row) => isRecord(row))
    .map((row) => ({
      block_id: String(row.block_id ?? ''),
      type: String(row.type ?? '').toLowerCase(),
      page: Number(row.page),
      bbox: Array.isArray(row.bbox) ? row.bbox : null,
      text: typeof row.text === 'string' ? row.text : null,
      data: isRecord(row.data) ? row.data : {},
      block_sha: String(row.block_sha ?? ''),
      source_rank: 1
    }))
    .filter(
      (row) =>
        row.block_id.length > 0 &&
        ['text', 'table', 'figure', 'code'].includes(row.type) &&
        Number.isFinite(row.page) &&
        Number.isInteger(row.page) &&
        row.page >= 1 &&
        /^[a-f0-9]{64}$/.test(row.block_sha)
    )
    .sort((a, b) => a.page - b.page || a.block_id.localeCompare(b.block_id));
}

/**
 * @param {string} type
 */
function isTextOrTable(type) {
  return type === 'text' || type === 'table';
}

/**
 * @param {{docId:string,version:number,pageIdx0:number,patch:Record<string, unknown>}} params
 */
function buildOcrBlocksForPage(params) {
  const page = params.pageIdx0 + 1;
  /** @type {Array<{type:'text'|'table',text:string|null,data:Record<string, unknown>,source_rank:number}>} */
  const source = [];

  const textMd = String(params.patch.text_md ?? '').trim();
  if (textMd.length > 0) {
    source.push({
      type: 'text',
      text: textMd,
      data: {
        source: 'ocr',
        source_rank: 0,
        page_idx: params.pageIdx0,
        text_md: textMd
      },
      source_rank: 0
    });
  }

  const tables = Array.isArray(params.patch.tables) ? params.patch.tables : [];
  tables.forEach((table, idx) => {
    const tablePayload = stableStringify(table);
    source.push({
      type: 'table',
      text: tablePayload,
      data: {
        source: 'ocr',
        source_rank: 0,
        page_idx: params.pageIdx0,
        table_idx: idx,
        table
      },
      source_rank: 0
    });
  });

  return source.map((row) => {
    const payload = {
      source: 'ocr',
      source_rank: row.source_rank,
      page,
      type: row.type,
      text: row.text,
      data: row.data
    };
    const blockSha = sha256(stableStringify(payload));
    return {
      block_id: deriveBlockId(params.docId, params.version, page, row.type, blockSha),
      type: row.type,
      page,
      bbox: null,
      text: row.text,
      data: row.data,
      block_sha: blockSha,
      source_rank: row.source_rank
    };
  });
}

/**
 * @param {Array<{block_sha:string}>} blocks
 */
function hashBlockShaSet(blocks) {
  const shas = blocks.map((row) => row.block_sha).sort((a, b) => a.localeCompare(b));
  return {
    shas,
    sha: sha256(JSON.stringify(shas))
  };
}

/**
 * @param {Array<{block_sha:string}>} beforeBlocks
 * @param {Array<{block_sha:string}>} afterBlocks
 */
function countChangedBlocks(beforeBlocks, afterBlocks) {
  const before = new Set(beforeBlocks.map((row) => row.block_sha));
  const after = new Set(afterBlocks.map((row) => row.block_sha));
  let delta = 0;
  for (const sha of before) {
    if (!after.has(sha)) delta += 1;
  }
  for (const sha of after) {
    if (!before.has(sha)) delta += 1;
  }
  return delta;
}

/**
 * @param {{docId:string,version:number,hardPages:unknown,patches:unknown,currentBlocks:unknown}} params
 */
export function computeOcrMergePlan(params) {
  const blocks = asLedgerBlocks(params.currentBlocks);
  const hardPages = asPageIdxSet(params.hardPages);
  const patchRows = asPatchRows(params.patches);
  const patchByPage = new Map(patchRows.map((row) => [row.page_idx, row.patch]));

  /** @type {Map<number, Array<ReturnType<typeof asLedgerBlocks>[number]>>} */
  const markerByPage = new Map();
  for (const block of blocks) {
    const pageIdx = block.page - 1;
    const rows = markerByPage.get(pageIdx) ?? [];
    rows.push(block);
    markerByPage.set(pageIdx, rows);
  }

  /** @type {Array<{page_idx:number,before_sha:string,after_sha:string,changed_blocks:number,diff_sha:string}>} */
  const pageDiffs = [];
  /** @type {Array<{block_id:string,type:string,page:number,bbox:Array<number>|null,text:string|null,data:Record<string, unknown>,block_sha:string}>} */
  const replacementBlocks = [];
  const mergedPages = [...hardPages].sort((a, b) => a - b);

  for (const pageIdx of mergedPages) {
    const markerBlocks = markerByPage.get(pageIdx) ?? [];
    const patch = patchByPage.get(pageIdx) ?? {};
    const ocrBlocks = buildOcrBlocksForPage({
      docId: params.docId,
      version: params.version,
      pageIdx0: pageIdx,
      patch
    });
    const keepMarkerText = ocrBlocks.length < 1;
    const kept = keepMarkerText
      ? markerBlocks
      : markerBlocks.filter((row) => !isTextOrTable(row.type));
    const candidates = [...kept, ...ocrBlocks];
    candidates.sort(
      (left, right) =>
        left.block_sha.localeCompare(right.block_sha) ||
        Number(left.source_rank ?? 1) - Number(right.source_rank ?? 1) ||
        left.block_id.localeCompare(right.block_id)
    );
    const seen = new Set();
    const afterBlocks = [];
    for (const row of candidates) {
      if (seen.has(row.block_sha)) continue;
      seen.add(row.block_sha);
      afterBlocks.push(row);
    }
    const beforeHash = hashBlockShaSet(markerBlocks);
    const afterHash = hashBlockShaSet(afterBlocks);
    const changedBlocks = countChangedBlocks(markerBlocks, afterBlocks);
    const diffSha = sha256(
      JSON.stringify({
        page: pageIdx,
        before: beforeHash.shas,
        after: afterHash.shas
      })
    );
    pageDiffs.push({
      page_idx: pageIdx,
      before_sha: beforeHash.sha,
      after_sha: afterHash.sha,
      changed_blocks: changedBlocks,
      diff_sha: diffSha
    });
    replacementBlocks.push(...afterBlocks.filter((row) => Number(row.source_rank ?? 1) === 0));
  }

  const summary = pageDiffs.map((row) => ({
    page_idx: row.page_idx,
    before_sha: row.before_sha,
    after_sha: row.after_sha,
    changed_blocks: row.changed_blocks,
    diff_sha: row.diff_sha
  }));
  const diffSha = summary.length > 0 ? sha256(JSON.stringify(summary)) : null;
  return {
    merged_pages: mergedPages,
    replacement_blocks: replacementBlocks.map((row) => ({
      block_id: row.block_id,
      type: row.type,
      page: row.page,
      bbox: row.bbox,
      text: row.text,
      data: row.data,
      block_sha: row.block_sha
    })),
    page_diffs: pageDiffs,
    diff_sha: diffSha
  };
}
