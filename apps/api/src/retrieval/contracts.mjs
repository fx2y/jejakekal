export const RETRIEVAL_K_BUDGET = Object.freeze({
  lex: 200,
  trgm: 50,
  vec: 200,
  tbl: 200,
  fused: 200,
  final: 40,
  kRRF: 60
});

export const RETRIEVAL_DEFAULT_NAMESPACE = 'default';

export const RETRIEVAL_BLOCK_TYPE_PRIORITY = Object.freeze({
  heading: 50,
  header: 45,
  paragraph: 40,
  text: 35,
  list: 30,
  quote: 25,
  table: 20
});

/**
 * @param {string | null | undefined} type
 */
export function getRetrievalBlockTypePriority(type) {
  const key = String(type ?? '').trim().toLowerCase();
  if (!key) return 0;
  return RETRIEVAL_BLOCK_TYPE_PRIORITY[key] ?? 10;
}
