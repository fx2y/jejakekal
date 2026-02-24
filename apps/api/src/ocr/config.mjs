const OCR_ENGINE_SET = new Set(['vllm', 'sglang', 'ollama']);

/**
 * @typedef {{
 *   enabled: boolean,
 *   engine: 'vllm'|'sglang'|'ollama',
 *   model: string,
 *   baseUrl: string,
 *   timeoutMs: number,
 *   maxPages: number
 * }} OcrPolicy
 */

/**
 * @param {unknown} value
 * @param {string} field
 */
function parsePositiveInt(value, field) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`invalid_ocr_policy_${field}`);
  }
  return parsed;
}

/**
 * @param {unknown} value
 */
function parseEnabled(value) {
  if (value == null || value === '') return true;
  if (value === '0' || value === 0 || value === false) return false;
  if (value === '1' || value === 1 || value === true) return true;
  throw new Error('invalid_ocr_policy_enabled');
}

/**
 * @param {unknown} value
 */
function parseEngine(value) {
  const normalized = String(value ?? 'vllm').trim().toLowerCase();
  if (!OCR_ENGINE_SET.has(normalized)) {
    throw new Error('invalid_ocr_policy_engine');
  }
  return /** @type {'vllm'|'sglang'|'ollama'} */ (normalized);
}

/**
 * @param {unknown} value
 * @param {string} field
 */
function parseNonEmptyString(value, field) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new Error(`invalid_ocr_policy_${field}`);
  }
  return normalized;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {OcrPolicy}
 */
export function resolveOcrPolicy(env = process.env) {
  return Object.freeze({
    enabled: parseEnabled(env.OCR_ENABLED),
    engine: parseEngine(env.OCR_ENGINE),
    model: parseNonEmptyString(env.OCR_MODEL ?? 'zai-org/GLM-OCR', 'model'),
    baseUrl: parseNonEmptyString(env.OCR_BASE_URL ?? 'http://127.0.0.1:8000', 'base_url'),
    timeoutMs: parsePositiveInt(env.OCR_TIMEOUT_MS ?? 120000, 'timeout_ms'),
    maxPages: parsePositiveInt(env.OCR_MAX_PAGES ?? 10, 'max_pages')
  });
}

/**
 * @param {unknown} input
 * @returns {OcrPolicy}
 */
export function normalizeOcrPolicyInput(input) {
  const row = input && typeof input === 'object' ? /** @type {Record<string, unknown>} */ (input) : {};
  return Object.freeze({
    enabled: parseEnabled(row.enabled),
    engine: parseEngine(row.engine),
    model: parseNonEmptyString(row.model, 'model'),
    baseUrl: parseNonEmptyString(row.baseUrl, 'base_url'),
    timeoutMs: parsePositiveInt(row.timeoutMs, 'timeout_ms'),
    maxPages: parsePositiveInt(row.maxPages, 'max_pages')
  });
}
