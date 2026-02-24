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
 * @param {unknown} value
 */
function asFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * @param {unknown} value
 */
function sanitizeLane(value) {
  const lanes = asArray(value)
    ?.map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean) ?? [];
  return [...new Set(lanes)].sort((a, b) => a.localeCompare(b));
}

/**
 * @param {unknown} value
 */
function sanitizeLaneReasons(value) {
  const reasons = asArray(value)
    ?.map((entry) => asRecord(entry))
    .filter(Boolean)
    .map((reason) => {
      const lane = typeof reason.lane === 'string' ? reason.lane.trim() : '';
      const rankPos = Math.trunc(Number(reason.rank_pos));
      if (!lane || !Number.isFinite(rankPos) || rankPos < 1) return null;
      const laneRank = asFiniteNumber(reason.lane_rank);
      const distance = asFiniteNumber(reason.distance);
      const matchKind = typeof reason.match_kind === 'string' ? reason.match_kind.trim() : null;
      return {
        lane,
        rank_pos: rankPos,
        ...(laneRank != null ? { lane_rank: laneRank } : {}),
        ...(distance != null ? { distance } : {}),
        ...(matchKind ? { match_kind: matchKind } : {})
      };
    })
    .filter(Boolean) ?? [];
  return reasons.sort((a, b) => a.rank_pos - b.rank_pos || a.lane.localeCompare(b.lane));
}

/**
 * @param {unknown} value
 */
function sanitizeCite(value) {
  const cite = asRecord(value);
  if (!cite) return null;
  const docVersion = Math.trunc(Number(cite.doc_version));
  const page = cite.page == null ? null : Math.trunc(Number(cite.page));
  const bbox =
    asArray(cite.bbox)
      ?.map((entry) => asFiniteNumber(entry))
      .filter((entry) => entry != null) ?? [];
  const blockHash = typeof cite.block_hash === 'string' ? cite.block_hash : null;
  const blockId = typeof cite.block_id === 'string' ? cite.block_id : null;
  if (!Number.isFinite(docVersion)) return null;
  if (page != null && (!Number.isFinite(page) || page < 0)) return null;
  if (!blockId) return null;
  return {
    doc_version: docVersion,
    page: page == null ? null : page,
    bbox,
    block_hash: blockHash,
    block_id: blockId
  };
}

/**
 * @param {Record<string, unknown>} candidate
 */
function sanitizeCandidate(candidate) {
  const docId = typeof candidate.doc_id === 'string' ? candidate.doc_id : null;
  const ver = Math.trunc(Number(candidate.ver));
  const blockId = typeof candidate.block_id === 'string' ? candidate.block_id : null;
  const rank = asFiniteNumber(candidate.rank);
  const rrfScore = asFiniteNumber(candidate.rrf_score);
  const lane = sanitizeLane(candidate.lane);
  const laneReasons = sanitizeLaneReasons(candidate.lane_reasons);
  const cite = sanitizeCite(candidate.cite);
  if (!docId || !Number.isFinite(ver) || !blockId || rank == null || !cite) return null;
  const out = {
    doc_id: docId,
    ver,
    block_id: blockId,
    rank,
    lane,
    lane_reasons: laneReasons,
    cite
  };
  if (rrfScore != null) out.rrf_score = rrfScore;
  if (typeof candidate.exact_phrase_hit === 'boolean') out.exact_phrase_hit = candidate.exact_phrase_hit;
  const vectorDistance = asFiniteNumber(candidate.vector_distance);
  if (vectorDistance != null) out.vector_distance = vectorDistance;
  if (typeof candidate.type === 'string' && candidate.type.trim()) out.type = candidate.type.trim();
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
      .map((candidate) => sanitizeCandidate(candidate))
      .filter(Boolean) ?? [];
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
