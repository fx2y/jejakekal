import { RETRIEVAL_K_BUDGET } from '../contracts.mjs';
import { resolveEmbeddingModel } from '../embeddings.mjs';

/**
 * @param {unknown} value
 */
function normalizeQuery(value) {
  return String(value ?? '').trim();
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} max
 * @param {string} code
 */
function resolvePositiveInt(value, fallback, max, code) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(code);
  const int = Math.trunc(parsed);
  if (int < 1) throw new Error(code);
  return Math.min(max, int);
}

/**
 * @param {unknown} value
 * @returns {'hnsw'|'ivf'}
 */
function resolveVectorIndexType(value) {
  if (value == null || value === '') return 'hnsw';
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'hnsw' || normalized === 'ivf') return normalized;
  throw new Error('invalid_vector_index_type');
}

/**
 * @param {unknown} value
 */
function isVectorLaneEnabled(value) {
  if (value === true) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = /** @type {Record<string, unknown>} */ (value);
  return record.enabled === true;
}

/**
 * @param {{
 *   query?:unknown,
 *   limit?:unknown,
 *   scope:{namespaces:string[], acl?:Record<string, unknown>},
 *   enableVector?:unknown,
 *   vector?:unknown
 * }} params
 * @returns {null|{
 *   lane:'vector',
 *   query:string,
 *   limit:number,
 *   candidateLimit:number,
 *   efSearch:number,
 *   ivfProbes:number,
 *   indexType:'hnsw'|'ivf',
 *   model:string,
 *   scope:{namespaces:string[], acl?:Record<string, unknown>}
 * }}
 */
export function buildVectorLanePlan(params) {
  const enabled = params.enableVector === true || isVectorLaneEnabled(params.vector);
  if (!enabled) return null;
  const query = normalizeQuery(params.query);
  if (!query) return null;
  const vectorCfg =
    params.vector && typeof params.vector === 'object' && !Array.isArray(params.vector)
      ? /** @type {Record<string, unknown>} */ (params.vector)
      : {};
  const limit = resolvePositiveInt(params.limit, RETRIEVAL_K_BUDGET.final, RETRIEVAL_K_BUDGET.vec, 'invalid_vector_limit');
  const candidateLimit = resolvePositiveInt(
    vectorCfg.candidateLimit,
    Math.max(limit * 4, 50),
    RETRIEVAL_K_BUDGET.vec,
    'invalid_vector_candidate_limit'
  );
  return {
    lane: 'vector',
    query,
    limit,
    candidateLimit: Math.max(limit, candidateLimit),
    efSearch: resolvePositiveInt(vectorCfg.efSearch, 80, 10_000, 'invalid_vector_ef_search'),
    ivfProbes: resolvePositiveInt(vectorCfg.ivfProbes, 10, 10_000, 'invalid_vector_ivf_probes'),
    indexType: resolveVectorIndexType(vectorCfg.indexType),
    model: resolveEmbeddingModel(vectorCfg.model),
    scope: params.scope
  };
}
