import { RETRIEVAL_K_BUDGET, getRetrievalBlockTypePriority } from './contracts.mjs';

/**
 * @typedef {{
 *  doc_id:string,
 *  ver:number,
 *  block_id:string,
 *  rank?:number,
 *  distance?:number,
 *  type?:string|null,
 *  page?:number|null,
 *  bbox?:unknown,
 *  block_sha?:string|null,
 *  text?:string|null,
 *  cite?:unknown,
 *  match_kind?:string
 * }} RetrievalLaneRow
 */

/**
 * @param {{doc_id:string, ver:number, block_id:string}} row
 */
function blockKey(row) {
  return `${row.doc_id}:${row.ver}:${row.block_id}`;
}

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
 * @returns {number[]|null}
 */
function asNumberArray(value) {
  if (!Array.isArray(value)) return null;
  const out = value.map((entry) => Number(entry));
  return out.every((entry) => Number.isFinite(entry)) ? out : null;
}

/**
 * @param {unknown} value
 */
function normalizeSpace(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * @param {string} query
 */
function extractQuotedPhrases(query) {
  const phrases = new Set();
  const text = String(query ?? '');
  for (const match of text.matchAll(/"([^"]+)"/g)) {
    const phrase = normalizeSpace(match[1]);
    if (phrase) phrases.add(phrase);
  }
  return [...phrases];
}

/**
 * @param {unknown} row
 * @param {{doc_id:string, ver:number, block_id:string, page?:number|null, bbox?:unknown, block_sha?:string|null}} fallback
 */
function toProvenanceCite(row, fallback) {
  const cite = asRecord(asRecord(row)?.cite);
  if (cite) {
    return {
      doc_version: Number(cite.doc_version ?? fallback.ver),
      page: cite.page == null ? null : Number(cite.page),
      bbox: asNumberArray(cite.bbox),
      block_hash: typeof cite.block_hash === 'string' ? cite.block_hash : fallback.block_sha ?? null,
      block_id: typeof cite.block_id === 'string' ? cite.block_id : fallback.block_id
    };
  }
  return {
    doc_version: fallback.ver,
    page: fallback.page == null ? null : Number(fallback.page),
    bbox: asNumberArray(fallback.bbox),
    block_hash: fallback.block_sha ?? null,
    block_id: fallback.block_id
  };
}

/**
 * @param {{doc_id:string, ver:number, block_id:string, score:number}} a
 * @param {{doc_id:string, ver:number, block_id:string, score:number}} b
 */
function compareByScoreThenBlock(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (a.doc_id !== b.doc_id) return a.doc_id.localeCompare(b.doc_id);
  if (a.ver !== b.ver) return a.ver - b.ver;
  return a.block_id.localeCompare(b.block_id);
}

/**
 * @param {{
 *  laneResults: Array<{lane:string, rows:Array<RetrievalLaneRow>}>,
 *  kRRF?: number,
 *  limit?: number
 * }} params
 */
export function fuseByReciprocalRank(params) {
  const kRRF = Math.max(1, Math.trunc(Number(params.kRRF ?? RETRIEVAL_K_BUDGET.kRRF)));
  const limit = Math.max(1, Math.trunc(Number(params.limit ?? RETRIEVAL_K_BUDGET.final)));
  const byBlock = new Map();
  for (const laneResult of params.laneResults) {
    const rows = Array.isArray(laneResult.rows) ? laneResult.rows : [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = /** @type {RetrievalLaneRow} */ (rows[index]);
      const key = blockKey(row);
      const existing = byBlock.get(key) ?? {
        doc_id: row.doc_id,
        ver: row.ver,
        block_id: row.block_id,
        lane_hits: [],
        lane_reasons: [],
        score: 0,
        type: typeof row.type === 'string' ? row.type : null,
        page: row.page == null ? null : Number(row.page),
        bbox: asNumberArray(row.bbox),
        block_sha: typeof row.block_sha === 'string' ? row.block_sha : null,
        cite: null,
        vector_distance: Number.isFinite(Number(row.distance)) ? Number(row.distance) : null,
        phrase_text: typeof row.text === 'string' ? row.text : null
      };
      existing.score += 1 / (kRRF + index + 1);
      if (!existing.lane_hits.includes(laneResult.lane)) {
        existing.lane_hits.push(laneResult.lane);
      }
      existing.lane_reasons.push({
        lane: laneResult.lane,
        rank_pos: index + 1,
        lane_rank: Number.isFinite(Number(row.rank)) ? Number(row.rank) : null,
        ...(Number.isFinite(Number(row.distance)) ? { distance: Number(row.distance) } : {}),
        ...(typeof row.match_kind === 'string' ? { match_kind: row.match_kind } : {})
      });
      if (!existing.cite) {
        existing.cite = toProvenanceCite(row, existing);
      }
      if (!existing.type && typeof row.type === 'string') existing.type = row.type;
      if (existing.page == null && row.page != null) existing.page = Number(row.page);
      if (!existing.bbox && Array.isArray(row.bbox)) existing.bbox = asNumberArray(row.bbox);
      if (!existing.block_sha && typeof row.block_sha === 'string') existing.block_sha = row.block_sha;
      if (existing.vector_distance == null && Number.isFinite(Number(row.distance))) {
        existing.vector_distance = Number(row.distance);
      }
      if (!existing.phrase_text && typeof row.text === 'string') {
        existing.phrase_text = row.text;
      }
      byBlock.set(key, existing);
    }
  }
  return [...byBlock.values()]
    .map((row) => ({
      ...row,
      lane_reasons: row.lane_reasons.sort((a, b) => a.rank_pos - b.rank_pos || a.lane.localeCompare(b.lane)),
      lane_hits: [...row.lane_hits].sort((a, b) => a.localeCompare(b)),
      cite:
        row.cite ??
        toProvenanceCite(
          {},
          {
            doc_id: row.doc_id,
            ver: row.ver,
            block_id: row.block_id,
            page: row.page,
            bbox: row.bbox,
            block_sha: row.block_sha
          }
        )
    }))
    .sort(compareByScoreThenBlock)
    .slice(0, limit);
}

/**
 * @param {{score:number, ver:number, type?:string|null, vector_distance?:number|null, phrase_text?:string|null}} row
 * @param {string[]} quotedPhrases
 */
function computeExactRerankScore(row, quotedPhrases) {
  const phraseText = normalizeSpace(row.phrase_text);
  const exactPhraseHit =
    quotedPhrases.length > 0 && phraseText ? quotedPhrases.some((phrase) => phraseText.includes(phrase)) : false;
  const typePriority = getRetrievalBlockTypePriority(row.type ?? null);
  const freshness = Number(row.ver) || 0;
  const vectorDistance = Number.isFinite(Number(row.vector_distance)) ? Number(row.vector_distance) : null;
  const vectorBoost = vectorDistance == null ? 0 : Math.max(0, 2 - Math.max(0, vectorDistance));
  const rerankScore =
    (exactPhraseHit ? 1 : 0) * 100 +
    typePriority * 0.01 +
    freshness * 0.000001 +
    vectorBoost * 0.001 +
    Number(row.score);
  return {
    rerankScore,
    exactPhraseHit,
    typePriority,
    vectorDistance
  };
}

/**
 * @param {Array<any>} fused
 * @param {{query:string, limit?:number}} params
 */
export function exactRerankFusedCandidates(fused, params) {
  const limit = Math.max(1, Math.trunc(Number(params.limit ?? RETRIEVAL_K_BUDGET.final)));
  const quotedPhrases = extractQuotedPhrases(String(params.query ?? ''));
  return [...fused]
    .map((row) => {
      const details = computeExactRerankScore(row, quotedPhrases);
      return {
        ...row,
        exact_phrase_hit: details.exactPhraseHit,
        type_priority: details.typePriority,
        vector_distance: details.vectorDistance,
        rank: details.rerankScore,
        rrf_score: row.score
      };
    })
    .sort((a, b) => {
      if (b.rank !== a.rank) return b.rank - a.rank;
      if (a.doc_id !== b.doc_id) return a.doc_id.localeCompare(b.doc_id);
      if (a.ver !== b.ver) return a.ver - b.ver;
      return a.block_id.localeCompare(b.block_id);
    })
    .slice(0, limit)
    .map((row) => ({
      doc_id: row.doc_id,
      ver: row.ver,
      block_id: row.block_id,
      rank: row.rank,
      rrf_score: row.rrf_score,
      lane: row.lane_hits,
      lane_reasons: row.lane_reasons,
      cite: row.cite,
      exact_phrase_hit: row.exact_phrase_hit,
      ...(row.vector_distance != null ? { vector_distance: row.vector_distance } : {}),
      ...(typeof row.type === 'string' ? { type: row.type } : {})
    }));
}
