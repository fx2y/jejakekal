import { RETRIEVAL_K_BUDGET } from '../contracts.mjs';
import { resolveFtsLanguage } from './lexical.mjs';

/**
 * @param {unknown} value
 */
function normalizeQuery(value) {
  return String(value ?? '').trim();
}

/**
 * @param {unknown} value
 */
function resolveLaneLimit(value) {
  const parsed = Number(value ?? RETRIEVAL_K_BUDGET.tbl);
  if (!Number.isFinite(parsed)) return RETRIEVAL_K_BUDGET.tbl;
  const bounded = Math.trunc(parsed);
  return Math.max(1, Math.min(RETRIEVAL_K_BUDGET.tbl, bounded));
}

/**
 * @param {{query?:unknown, language?:unknown, limit?:unknown, scope:{namespaces:string[],acl?:Record<string, unknown>}}} params
 */
export function buildTableLanePlan(params) {
  const query = normalizeQuery(params.query);
  if (!query) return null;
  return {
    lane: 'table',
    query,
    language: resolveFtsLanguage(params.language),
    limit: resolveLaneLimit(params.limit),
    scope: params.scope
  };
}
