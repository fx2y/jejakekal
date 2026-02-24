import { RETRIEVAL_DEFAULT_NAMESPACE } from './contracts.mjs';

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
 * C0 guardrail: schema/query adapters are single-tenant until `doc_block`+`acl` land.
 * @param {{namespaces:string[], acl?:Record<string, unknown>}} scope
 */
export function assertLegacyScopeCompatible(scope) {
  const isDefaultOnly =
    Array.isArray(scope.namespaces) &&
    scope.namespaces.length === 1 &&
    scope.namespaces[0] === RETRIEVAL_DEFAULT_NAMESPACE;
  const acl = scope.acl ?? {};
  const aclEntries = Object.keys(acl);
  if (!isDefaultOnly || aclEntries.length > 0) {
    throw new Error('retrieval_scope_unsupported');
  }
}
