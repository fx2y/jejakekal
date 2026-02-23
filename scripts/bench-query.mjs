import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { makeClient } from '../apps/api/src/db.mjs';
import { queryRankedBlocksByTsQuery } from '../apps/api/src/search/block-repository.mjs';
import { percentile, postRun, resetBenchState, waitForRunTerminal, withApiServer } from './bench-lib.mjs';

const BENCH_RUNS = 80;
const QUERY = 'invoice';
const SOURCE = 'invoice alpha\ninvoice beta\ninvoice gamma';

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
      const runs = [];
      for (let i = 0; i < BENCH_RUNS; i += 1) {
        const start = performance.now();
        const rows = await queryRankedBlocksByTsQuery(client, { query: QUERY, limit: 25 });
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
