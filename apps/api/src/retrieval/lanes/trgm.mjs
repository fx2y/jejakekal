import { RETRIEVAL_K_BUDGET } from '../contracts.mjs';

const DEFAULT_TRGM_THRESHOLD = 0.3;
const MIN_TRGM_QUERY_LEN = 3;
const MAX_TRGM_QUERY_LEN = 64;

/**
 * @param {unknown} value
 */
function normalizeQuery(value) {
  const query = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  if (/["'():|&!<>-]/.test(query)) {
    return null;
  }
  if (query.length < MIN_TRGM_QUERY_LEN || query.length > MAX_TRGM_QUERY_LEN) {
    return null;
  }
  return query;
}

/**
 * @param {unknown} value
 */
function resolveLaneLimit(value) {
  const parsed = Number(value ?? RETRIEVAL_K_BUDGET.trgm);
  if (!Number.isFinite(parsed)) return RETRIEVAL_K_BUDGET.trgm;
  const bounded = Math.trunc(parsed);
  return Math.max(1, Math.min(RETRIEVAL_K_BUDGET.trgm, bounded));
}

/**
 * @param {unknown} value
 */
function resolveSimilarityThreshold(value) {
  if (value == null) return DEFAULT_TRGM_THRESHOLD;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error('invalid_trgm_threshold');
  }
  if (parsed < 0 || parsed > 1) {
    throw new Error('invalid_trgm_threshold');
  }
  return parsed;
}

/**
 * @param {{query?:unknown, limit?:unknown, scope:{namespaces:string[],acl?:Record<string, unknown>}, trgmThreshold?:unknown}} params
 */
export function buildTrgmLanePlan(params) {
  const query = normalizeQuery(params.query);
  if (!query) return null;
  return {
    lane: 'trgm',
    query,
    limit: resolveLaneLimit(params.limit),
    threshold: resolveSimilarityThreshold(params.trgmThreshold),
    scope: params.scope
  };
}
