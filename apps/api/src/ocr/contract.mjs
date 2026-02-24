/**
 * @typedef {{
 *   doc_id: string,
 *   ver: number,
 *   page_idx: number,
 *   image_uri: string,
 *   prompt: string
 * }} OCRPageIn
 */

/**
 * @typedef {{
 *   text_md: string,
 *   tables?: unknown[],
 *   confidence?: number | null,
 *   engine_meta: Record<string, unknown>,
 *   raw: unknown
 * }} OCRPageOut
 */

/**
 * @param {unknown} value
 * @param {string} field
 */
function assertNonEmptyString(value, field) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new Error(`invalid_ocr_${field}`);
  }
  return normalized;
}

/**
 * @param {unknown} value
 * @param {string} field
 */
function assertPositiveInt(value, field) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`invalid_ocr_${field}`);
  }
  return parsed;
}

/**
 * @param {unknown} value
 * @param {string} field
 */
function assertNonNegativeInt(value, field) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`invalid_ocr_${field}`);
  }
  return parsed;
}

/**
 * @param {unknown} value
 */
function toEngineMeta(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return /** @type {Record<string, unknown>} */ (value);
  }
  return {};
}

/**
 * @param {unknown} value
 */
function toTables(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * @param {unknown} value
 */
function toConfidence(value) {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * @param {unknown} value
 * @returns {OCRPageIn}
 */
export function normalizeOcrPageIn(value) {
  const row = value && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value) : {};
  return {
    doc_id: assertNonEmptyString(row.doc_id, 'doc_id'),
    ver: assertPositiveInt(row.ver, 'ver'),
    page_idx: assertNonNegativeInt(row.page_idx, 'page_idx'),
    image_uri: assertNonEmptyString(row.image_uri, 'image_uri'),
    prompt: assertNonEmptyString(row.prompt, 'prompt')
  };
}

/**
 * @param {unknown} value
 * @returns {OCRPageOut}
 */
export function normalizeOcrPageOut(value) {
  const row = value && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value) : {};
  if (!Object.prototype.hasOwnProperty.call(row, 'raw')) {
    throw new Error('invalid_ocr_raw');
  }
  return {
    text_md: String(row.text_md ?? ''),
    tables: toTables(row.tables),
    confidence: toConfidence(row.confidence),
    engine_meta: toEngineMeta(row.engine_meta),
    raw: row.raw
  };
}
