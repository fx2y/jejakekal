/**
 * @param {unknown} value
 */
function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

/**
 * @param {unknown} value
 */
function asArray(value) {
  return Array.isArray(value) ? value : null;
}

/**
 * @param {Record<string, unknown>} candidate
 */
function sanitizeCandidate(candidate) {
  const out = {};
  for (const key of [
    'doc_id',
    'ver',
    'block_id',
    'rank',
    'rrf_score',
    'lane',
    'lane_reasons',
    'cite',
    'exact_phrase_hit',
    'vector_distance',
    'type'
  ]) {
    if (key in candidate) out[key] = candidate[key];
  }
  return out;
}

/**
 * Additive export seam for future retrieval-producing steps.
 * Accepts either `output.retrieval` or `output.retrieval_candidates`.
 * Sanitizes to provenance-only contract and drops raw text/snippets.
 * @param {Array<{function_name?: string, output?: unknown}>} timeline
 */
export function buildRetrievalBundleSidecars(timeline) {
  const entries = [];
  for (const row of timeline) {
    const output = asRecord(row.output);
    if (!output) continue;
    const retrieval = asRecord(output.retrieval);
    const embeddedCandidates = asArray(output.retrieval_candidates);
    const source = retrieval ?? (embeddedCandidates ? { candidates: embeddedCandidates } : null);
    if (!source) continue;
    const candidates = asArray(source.candidates)
      ?.map((entry) => asRecord(entry))
      .filter(Boolean)
      .map((candidate) => sanitizeCandidate(candidate)) ?? [];
    entries.push({
      step: typeof row.function_name === 'string' ? row.function_name : 'unknown',
      query: typeof source.query === 'string' ? source.query : null,
      candidates
    });
  }
  if (entries.length < 1) return null;
  return {
    retrieval_summary: {
      retrieval_events: entries.length,
      candidate_count: entries.reduce((sum, entry) => sum + entry.candidates.length, 0)
    },
    retrieval_results: { retrieval: entries }
  };
}
