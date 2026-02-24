import { queryLexicalLaneRows, queryTrgmLaneRows, queryVectorLaneRows } from '../search/block-repository.mjs';
import { RETRIEVAL_K_BUDGET } from './contracts.mjs';
import { embedTextDeterministic } from './embeddings.mjs';
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
 * @param {{
 *  queryLexicalLaneRows: typeof queryLexicalLaneRows,
 *  queryTrgmLaneRows: typeof queryTrgmLaneRows,
 *  queryVectorLaneRows: typeof queryVectorLaneRows
 * }} deps
 */
export function createRetrievalService(deps) {
  /**
   * @param {import('pg').Client} client
   * @param {{query: unknown, language?: unknown, limit?: unknown, trgmThreshold?: unknown, enableVector?: unknown, vector?: unknown, scope: unknown}} params
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
    const trgmPlan = buildTrgmLanePlan({
      query: params.query,
      limit: params.limit,
      scope,
      trgmThreshold: params.trgmThreshold
    });
    const vectorPlan = buildVectorLanePlan({
      query: params.query,
      limit: params.limit,
      enableVector: params.enableVector,
      vector: params.vector,
      scope
    });
    buildTableLanePlan(params);
    if (!lexicalPlan && !trgmPlan && !vectorPlan) {
      return [];
    }
    const vectorQuery = vectorPlan ? embedTextDeterministic(vectorPlan.query) : null;
    const [lexicalRowsRaw, trgmRowsRaw, vectorRowsRaw] = await Promise.all([
      lexicalPlan ? deps.queryLexicalLaneRows(client, lexicalPlan) : Promise.resolve([]),
      trgmPlan ? deps.queryTrgmLaneRows(client, trgmPlan) : Promise.resolve([]),
      vectorPlan && vectorQuery
        ? deps.queryVectorLaneRows(client, {
            queryVector: vectorQuery,
            model: vectorPlan.model,
            limit: vectorPlan.limit,
            candidateLimit: vectorPlan.candidateLimit,
            efSearch: vectorPlan.efSearch,
            ivfProbes: vectorPlan.ivfProbes,
            indexType: vectorPlan.indexType,
            scope: vectorPlan.scope
          })
        : Promise.resolve([])
    ]);
    const lexicalRows = sortLexicalRows(lexicalRowsRaw);
    const trgmRows = sortLexicalRows(trgmRowsRaw);
    const vectorRows = sortLexicalRows(vectorRowsRaw);
    const laneResults = [];
    if (lexicalRows.length > 0) {
      laneResults.push({ lane: 'lexical', rows: lexicalRows });
    }
    if (trgmRows.length > 0) {
      laneResults.push({ lane: 'trgm', rows: trgmRows });
    }
    if (vectorRows.length > 0) {
      laneResults.push({ lane: 'vector', rows: vectorRows });
    }
    if (laneResults.length < 1) {
      return [];
    }
    const fused = fuseByReciprocalRank({
      laneResults,
      kRRF: RETRIEVAL_K_BUDGET.kRRF,
      limit: lexicalPlan?.limit ?? trgmPlan?.limit
    });
    const lexicalByBlock = mapLexicalByBlock(lexicalRows);
    const trgmByBlock = mapLexicalByBlock(trgmRows);
    const vectorByBlock = mapLexicalByBlock(vectorRows);
    return fused.map((row) => {
      const key = `${row.doc_id}:${row.ver}:${row.block_id}`;
      const lexical = lexicalByBlock.get(key);
      const trgm = trgmByBlock.get(key);
      const vector = vectorByBlock.get(key);
      return {
        doc_id: row.doc_id,
        ver: row.ver,
        block_id: row.block_id,
        rank: lexical ? lexical.rank : trgm ? trgm.rank : vector ? vector.rank : row.score
      };
    });
  }

  return {
    queryRankedBlocksByTsQuery
  };
}

const retrievalService = createRetrievalService({ queryLexicalLaneRows, queryTrgmLaneRows, queryVectorLaneRows });

export const queryRankedBlocksByTsQuery = retrievalService.queryRankedBlocksByTsQuery;
