import { queryLexicalLaneRows } from '../search/block-repository.mjs';
import { RETRIEVAL_K_BUDGET } from './contracts.mjs';
import { fuseByReciprocalRank } from './fusion.mjs';
import { buildLexicalLanePlan } from './lanes/lexical.mjs';
import { buildTableLanePlan } from './lanes/table.mjs';
import { buildTrgmLanePlan } from './lanes/trgm.mjs';
import { buildVectorLanePlan } from './lanes/vector.mjs';
import { assertLegacyScopeCompatible, normalizeRetrievalScope } from './scope.mjs';

/**
 * @param {{doc_id:string, ver:number, block_id:string, rank:number}} a
 * @param {{doc_id:string, ver:number, block_id:string, rank:number}} b
 */
function compareLexicalRows(a, b) {
  if (b.rank !== a.rank) return b.rank - a.rank;
  if (a.doc_id !== b.doc_id) return a.doc_id.localeCompare(b.doc_id);
  if (a.ver !== b.ver) return a.ver - b.ver;
  return a.block_id.localeCompare(b.block_id);
}

/**
 * @param {Array<{doc_id:string, ver:number, block_id:string, rank:number}>} rows
 */
function sortLexicalRows(rows) {
  return [...rows].sort(compareLexicalRows);
}

/**
 * @param {Array<{doc_id:string, ver:number, block_id:string, rank:number}>} rows
 */
function mapLexicalByBlock(rows) {
  const map = new Map();
  for (const row of rows) {
    map.set(`${row.doc_id}:${row.ver}:${row.block_id}`, row);
  }
  return map;
}

/**
 * @param {{queryLexicalLaneRows: typeof queryLexicalLaneRows}} deps
 */
export function createRetrievalService(deps) {
  /**
   * @param {import('pg').Client} client
   * @param {{query: unknown, language?: unknown, limit?: unknown, scope: unknown}} params
   */
  async function queryRankedBlocksByTsQuery(client, params) {
    const scope = normalizeRetrievalScope(params.scope);
    assertLegacyScopeCompatible(scope);
    const lexicalPlan = buildLexicalLanePlan({
      query: params.query,
      language: params.language,
      limit: params.limit,
      scope
    });
    buildTrgmLanePlan(params);
    buildVectorLanePlan(params);
    buildTableLanePlan(params);
    if (!lexicalPlan) {
      return [];
    }
    const lexicalRows = sortLexicalRows(await deps.queryLexicalLaneRows(client, lexicalPlan));
    const fused = fuseByReciprocalRank({
      laneResults: [{ lane: 'lexical', rows: lexicalRows }],
      kRRF: RETRIEVAL_K_BUDGET.kRRF,
      limit: lexicalPlan.limit
    });
    const lexicalByBlock = mapLexicalByBlock(lexicalRows);
    return fused.map((row) => {
      const key = `${row.doc_id}:${row.ver}:${row.block_id}`;
      const lexical = lexicalByBlock.get(key);
      return {
        doc_id: row.doc_id,
        ver: row.ver,
        block_id: row.block_id,
        rank: lexical ? lexical.rank : row.score
      };
    });
  }

  return {
    queryRankedBlocksByTsQuery
  };
}

const retrievalService = createRetrievalService({ queryLexicalLaneRows });

export const queryRankedBlocksByTsQuery = retrievalService.queryRankedBlocksByTsQuery;
