import { queryLexicalLaneRows, queryTableLaneRows, queryTrgmLaneRows, queryVectorLaneRows } from '../search/block-repository.mjs';
import { RETRIEVAL_K_BUDGET } from './contracts.mjs';
import { embedTextDeterministic } from './embeddings.mjs';
import { exactRerankFusedCandidates, fuseByReciprocalRank } from './fusion.mjs';
import { buildLexicalLanePlan } from './lanes/lexical.mjs';
import { buildTableLanePlan } from './lanes/table.mjs';
import { buildTrgmLanePlan } from './lanes/trgm.mjs';
import { buildVectorLanePlan } from './lanes/vector.mjs';
import { assertRetrievalScopePolicy, normalizeRetrievalScope } from './scope.mjs';

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
 * @param {{
 *  queryLexicalLaneRows: typeof queryLexicalLaneRows,
 *  queryTableLaneRows: typeof queryTableLaneRows,
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
    assertRetrievalScopePolicy(scope);
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
    const tablePlan = buildTableLanePlan({
      query: params.query,
      language: params.language,
      limit: params.limit,
      scope
    });
    if (!lexicalPlan && !trgmPlan && !vectorPlan && !tablePlan) {
      return [];
    }
    const vectorQuery = vectorPlan ? embedTextDeterministic(vectorPlan.query) : null;
    const [lexicalRowsRaw, trgmRowsRaw, vectorRowsRaw, tableRowsRaw] = await Promise.all([
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
        : Promise.resolve([]),
      tablePlan ? deps.queryTableLaneRows(client, tablePlan) : Promise.resolve([])
    ]);
    const lexicalRows = sortLexicalRows(lexicalRowsRaw);
    const trgmRows = sortLexicalRows(trgmRowsRaw);
    const vectorRows = sortLexicalRows(vectorRowsRaw);
    const tableRows = sortLexicalRows(tableRowsRaw);
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
    if (tableRows.length > 0) {
      laneResults.push({ lane: 'table', rows: tableRows });
    }
    if (laneResults.length < 1) {
      return [];
    }
    const fused = fuseByReciprocalRank({
      laneResults,
      kRRF: RETRIEVAL_K_BUDGET.kRRF,
      limit: Math.max(
        lexicalPlan?.limit ?? 0,
        trgmPlan?.limit ?? 0,
        vectorPlan?.limit ?? 0,
        tablePlan?.limit ?? 0,
        RETRIEVAL_K_BUDGET.fused
      )
    });
    return exactRerankFusedCandidates(fused, {
      query: String(params.query ?? ''),
      limit:
        lexicalPlan?.limit ??
        trgmPlan?.limit ??
        vectorPlan?.limit ??
        tablePlan?.limit ??
        RETRIEVAL_K_BUDGET.final
    });
  }

  return {
    queryRankedBlocksByTsQuery
  };
}

const retrievalService = createRetrievalService({ queryLexicalLaneRows, queryTableLaneRows, queryTrgmLaneRows, queryVectorLaneRows });

export const queryRankedBlocksByTsQuery = retrievalService.queryRankedBlocksByTsQuery;
