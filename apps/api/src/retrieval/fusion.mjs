import { RETRIEVAL_K_BUDGET } from './contracts.mjs';

/**
 * @param {{doc_id:string, ver:number, block_id:string}} row
 */
function blockKey(row) {
  return `${row.doc_id}:${row.ver}:${row.block_id}`;
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
 *  laneResults: Array<{lane:string, rows:Array<{doc_id:string, ver:number, block_id:string}>}>,
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
      const row = rows[index];
      const key = blockKey(row);
      const existing = byBlock.get(key) ?? {
        doc_id: row.doc_id,
        ver: row.ver,
        block_id: row.block_id,
        lane_hits: [],
        score: 0
      };
      existing.score += 1 / (kRRF + index + 1);
      if (!existing.lane_hits.includes(laneResult.lane)) {
        existing.lane_hits.push(laneResult.lane);
      }
      byBlock.set(key, existing);
    }
  }
  return [...byBlock.values()].sort(compareByScoreThenBlock).slice(0, limit);
}
