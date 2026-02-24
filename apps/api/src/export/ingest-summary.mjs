/**
 * @param {Array<{function_name?:string,output?:unknown}>} timeline
 * @param {string} functionName
 */
function stepOutput(timeline, functionName) {
  const row = timeline.find((step) => step.function_name === functionName);
  if (!row || !row.output || typeof row.output !== 'object' || Array.isArray(row.output)) {
    return null;
  }
  return /** @type {Record<string, unknown>} */ (row.output);
}

/**
 * @param {Record<string, unknown> | null} row
 * @param {string} key
 */
function numberField(row, key) {
  const value = row?.[key];
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.trunc(parsed));
}

/**
 * @param {Record<string, unknown> | null} row
 * @param {string} key
 */
function stringField(row, key) {
  const value = row?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * @param {Record<string, unknown> | null} row
 * @param {string} key
 */
function stringListField(row, key) {
  const value = row?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string').map((item) => String(item)).sort();
}

/**
 * @param {Record<string, unknown> | null} row
 * @param {string} key
 */
function intListField(row, key) {
  const value = row?.[key];
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item >= 0))].sort(
    (a, b) => a - b
  );
}

/**
 * @param {Array<{function_name?:string,output?:unknown}>} timeline
 */
export function buildIngestManifestSummary(timeline) {
  const reserveDoc = stepOutput(timeline, 'reserve-doc');
  const storeRaw = stepOutput(timeline, 'store-raw');
  const storeParse = stepOutput(timeline, 'store-parse-outputs');
  const markerConvert = stepOutput(timeline, 'marker-convert');
  const normalize = stepOutput(timeline, 'normalize-docir');
  const indexFts = stepOutput(timeline, 'index-fts');
  const ocrGate = stepOutput(timeline, 'ocr-persist-gate');
  const ocrPages = stepOutput(timeline, 'ocr-pages');
  const ocrMerge = stepOutput(timeline, 'ocr-merge-diff');

  const docId = stringField(reserveDoc, 'doc_id');
  const version = numberField(reserveDoc, 'ver');
  const rawSha = stringField(reserveDoc, 'raw_sha');
  const rawKey = stringField(storeRaw, 'key');
  const parseKeys = stringListField(storeParse, 'parse_keys');
  const assetKeys = stringListField(storeParse, 'asset_keys');

  return {
    doc_id: docId,
    ver: version,
    raw_sha: rawSha,
    keys: {
      raw: rawKey,
      parse: parseKeys,
      assets: assetKeys
    },
    counts: {
      blocks: numberField(normalize, 'block_count'),
      chunk_index: numberField(markerConvert, 'chunk_count'),
      assets: numberField(storeParse, 'asset_count'),
      fts_indexed: numberField(indexFts, 'indexed')
    },
    timing_ms: {
      marker: numberField(storeParse, 'marker_timing_ms')
    },
    stderr_ref: stringField(storeParse, 'marker_stderr_sha'),
    ocr: {
      hard_pages: intListField(ocrGate, 'hard_pages'),
      ocr_pages: Array.isArray(ocrPages?.ocr_pages)
        ? ocrPages.ocr_pages
            .map((row) =>
              row && typeof row === 'object' && !Array.isArray(row)
                ? Number(/** @type {Record<string, unknown>} */ (row).page_idx)
                : NaN
            )
            .filter((value) => Number.isInteger(value) && value >= 0)
        : [],
      diff_sha: stringField(ocrMerge, 'diff_sha')
    }
  };
}
