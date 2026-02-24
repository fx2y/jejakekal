import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { makeClient } from '../apps/api/src/db.mjs';
import { queryRankedBlocksByTsQuery } from '../apps/api/src/retrieval/service.mjs';
import { inspectLexicalQuery, queryTrgmLaneRows } from '../apps/api/src/search/block-repository.mjs';
import { percentile, postRun, resetBenchState, waitForRunTerminal, withApiServer } from './bench-lib.mjs';

const BENCH_RUNS = 80;
const QUERY = 'invoice';
const TYPO_QUERY = 'invocie';
const SOURCE = 'invoice alpha\ninvoice beta\ninvoice gamma';

/**
 * @param {any} plan
 */
function collectPlanIndexes(plan) {
  const out = new Set();
  const stack = [plan];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (typeof node['Index Name'] === 'string') {
      out.add(node['Index Name']);
    }
    const subPlans = Array.isArray(node.Plans) ? node.Plans : [];
    for (const subPlan of subPlans) stack.push(subPlan);
  }
  return out;
}

async function main() {
  await resetBenchState();
  await withApiServer(async ({ baseUrl }) => {
    const runId = await postRun(baseUrl, { source: SOURCE, sleepMs: 10 });
    const run = await waitForRunTerminal(baseUrl, runId);
    if (run?.status !== 'done') {
      throw new Error(`bench_query_seed_failed:${runId}:${String(run?.status ?? 'missing')}`);
    }

    const client = makeClient();
    await client.connect();
    try {
      const diag = await inspectLexicalQuery(client, {
        query: QUERY,
        language: 'english'
      });
      if (!diag.indexable) {
        throw new Error(`bench_query_not_indexable:${diag.query}`);
      }
      const trgmRows = await queryTrgmLaneRows(client, {
        query: TYPO_QUERY,
        limit: 10,
        threshold: 0.3,
        scope: { namespaces: ['default'] }
      });
      if (!Array.isArray(trgmRows) || trgmRows.length < 1) {
        throw new Error('bench_query_trgm_empty_result');
      }
      await client.query('SET enable_seqscan = off');
      const trgmExplain = await client.query(
        `EXPLAIN (FORMAT JSON)
         SELECT b.id
         FROM doc_block b
         WHERE b.ns = ANY($2::text[])
           AND (
             (b.title_norm IS NOT NULL AND b.title_norm % $1)
             OR (b.entity_norm IS NOT NULL AND b.entity_norm % $1)
             OR (b.key_norm IS NOT NULL AND b.key_norm % $1)
           )
         ORDER BY b.id ASC
         LIMIT 20`,
        [TYPO_QUERY, ['default']]
      );
      await client.query('RESET enable_seqscan');
      const trgmPlan = trgmExplain.rows[0]?.['QUERY PLAN']?.[0]?.Plan;
      const planIndexes = collectPlanIndexes(trgmPlan);
      const hasTrgmIndex =
        planIndexes.has('doc_block_title_trgm_gin') ||
        planIndexes.has('doc_block_entity_trgm_gin') ||
        planIndexes.has('doc_block_key_trgm_gin');
      const planText = JSON.stringify(trgmPlan);
      const hasIndexScanNode =
        planText.includes('"Node Type":"Bitmap Index Scan"') ||
        planText.includes('"Node Type":"Index Scan"') ||
        planText.includes('"Node Type":"Index Only Scan"');
      if (!hasTrgmIndex && !hasIndexScanNode) {
        throw new Error('bench_query_trgm_index_missing');
      }
      const runs = [];
      for (let i = 0; i < BENCH_RUNS; i += 1) {
        const start = performance.now();
        const rows = await queryRankedBlocksByTsQuery(client, {
          query: QUERY,
          limit: 25,
          scope: { namespaces: ['default'] }
        });
        runs.push(performance.now() - start);
        if (!Array.isArray(rows) || rows.length === 0) {
          throw new Error('bench_query_empty_result');
        }
      }

      const metric = {
        query_p50_ms: Number(percentile(runs, 50).toFixed(2)),
        query_p95_ms: Number(percentile(runs, 95).toFixed(2)),
        fts_query_p95_ms: Number(percentile(runs, 95).toFixed(2))
      };

      await mkdir('.cache/bench', { recursive: true });
      await writeFile('.cache/bench/query.json', `${JSON.stringify(metric, null, 2)}\n`, 'utf8');
      process.stdout.write(`${JSON.stringify(metric)}\n`);
    } finally {
      await client.end();
    }
  });
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
