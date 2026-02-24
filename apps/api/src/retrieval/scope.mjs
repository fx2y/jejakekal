import { RETRIEVAL_DEFAULT_NAMESPACE } from './contracts.mjs';

const RETRIEVAL_SCOPE_MODE = String(process.env.RETRIEVAL_SCOPE_MODE ?? 'full')
  .trim()
  .toLowerCase();

/**
 * @param {unknown} value
 */
function normalizeNamespaceList(value) {
  if (!Array.isArray(value) || value.length < 1) {
    throw new Error('retrieval_scope_required');
  }
  const namespaces = [...new Set(value.map((entry) => String(entry ?? '').trim()).filter(Boolean))].sort();
  if (namespaces.length < 1) {
    throw new Error('retrieval_scope_required');
  }
  return namespaces;
}

/**
 * @param {unknown} value
 */
function normalizeOptionalObject(value) {
  if (value == null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('retrieval_scope_invalid_acl');
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {unknown} value
 */
export function normalizeRetrievalScope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('retrieval_scope_required');
  }
  const row = /** @type {Record<string, unknown>} */ (value);
  const namespaces = normalizeNamespaceList(row.namespaces);
  const acl = normalizeOptionalObject(row.acl);
  return {
    namespaces,
    ...(acl ? { acl } : {})
  };
}

/**
 * Optional rollout guard: set `RETRIEVAL_SCOPE_MODE=default-only` to enforce legacy single-tenant scope.
 * @param {{namespaces:string[], acl?:Record<string, unknown>}} scope
 */
export function assertRetrievalScopePolicy(scope) {
  if (RETRIEVAL_SCOPE_MODE !== 'default-only') {
    return;
  }
  const isDefaultOnly =
    Array.isArray(scope.namespaces) &&
    scope.namespaces.length === 1 &&
    scope.namespaces[0] === RETRIEVAL_DEFAULT_NAMESPACE;
  const acl = scope.acl ?? {};
  if (!isDefaultOnly || Object.keys(acl).length > 0) throw new Error('retrieval_scope_unsupported');
}
