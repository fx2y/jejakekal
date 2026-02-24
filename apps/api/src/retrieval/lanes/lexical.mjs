import { RETRIEVAL_K_BUDGET } from '../contracts.mjs';

const DEFAULT_FTS_LANGUAGE = 'english';

/**
 * @param {unknown} value
 */
function normalizeQuery(value) {
  return String(value ?? '').trim();
}

/**
 * @param {unknown} value
 */
export function resolveFtsLanguage(value) {
  const normalized = String(value ?? DEFAULT_FTS_LANGUAGE).trim().toLowerCase();
  if (normalized !== DEFAULT_FTS_LANGUAGE) {
    throw new Error('invalid_fts_language');
  }
  return normalized;
}

/**
 * @param {unknown} value
 */
function resolveLaneLimit(value) {
  const parsed = Number(value ?? 50);
  if (!Number.isFinite(parsed)) return 50;
  const bounded = Math.trunc(parsed);
  return Math.max(1, Math.min(RETRIEVAL_K_BUDGET.lex, bounded));
}

/**
 * @param {{query?:unknown, language?:unknown, limit?:unknown, scope: {namespaces:string[], acl?:Record<string, unknown>}}} params
 */
export function buildLexicalLanePlan(params) {
  const query = normalizeQuery(params.query);
  if (!query) return null;
  return {
    lane: 'lexical',
    query,
    language: resolveFtsLanguage(params.language),
    limit: resolveLaneLimit(params.limit),
    scope: params.scope
  };
}
