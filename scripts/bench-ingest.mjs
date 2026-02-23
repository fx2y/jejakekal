import { mkdir, writeFile } from 'node:fs/promises';
import { percentile, postRun, resetBenchState, waitForRunTerminal, withApiServer } from './bench-lib.mjs';

const BENCH_RUNS = 12;
const BENCH_WARMUP_RUNS = 2;
const BENCH_SOURCE = 'invoice alpha\ninvoice beta\ngamma delta';

/**
 * @param {Array<{function_name?:string,duration_ms?:number}>} timeline
 * @param {string} step
 */
function readStepDuration(timeline, step) {
  const row = Array.isArray(timeline) ? timeline.find((entry) => entry?.function_name === step) : null;
  const duration = Number(row?.duration_ms ?? 0);
  return Number.isFinite(duration) && duration >= 0 ? duration : 0;
}

/**
 * @param {Array<{started_at_epoch_ms?:number|null,completed_at_epoch_ms?:number|null,duration_ms?:number|null}>} timeline
 */
function readWorkflowDuration(timeline) {
  const rows = Array.isArray(timeline) ? timeline : [];
  return rows
    .map((row) => Number(row?.duration_ms ?? NaN))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .reduce((total, value) => total + value, 0);
}

async function main() {
  await resetBenchState();
  const totalRuns = [];
  const parserRuns = [];
  const normalizeRuns = [];
  const indexRuns = [];
  const ftsIngestRuns = [];

  await withApiServer(async ({ baseUrl }) => {
    for (let i = 0; i < BENCH_RUNS + BENCH_WARMUP_RUNS; i += 1) {
      const runId = await postRun(baseUrl, { source: `${BENCH_SOURCE}\nbench-${i}`, sleepMs: 10 });
      const run = await waitForRunTerminal(baseUrl, runId);
      if (run?.status !== 'done') {
        throw new Error(`bench_ingest_run_failed:${runId}:${String(run?.status ?? 'missing')}`);
      }
      if (i < BENCH_WARMUP_RUNS) {
        continue;
      }
      totalRuns.push(readWorkflowDuration(run.timeline));
      const parserMs = readStepDuration(run.timeline, 'marker-convert');
      const normalizeMs = readStepDuration(run.timeline, 'normalize-docir');
      const indexMs = readStepDuration(run.timeline, 'index-fts');
      parserRuns.push(parserMs);
      normalizeRuns.push(normalizeMs);
      indexRuns.push(indexMs);
      ftsIngestRuns.push(normalizeMs + indexMs);
    }
  });

  const metric = {
    ingest_p50_ms: Number(percentile(totalRuns, 50).toFixed(2)),
    ingest_p95_ms: Number(percentile(totalRuns, 95).toFixed(2)),
    fts_ingest_ms: Number(percentile(ftsIngestRuns, 95).toFixed(2)),
    parser_p95_ms: Number(percentile(parserRuns, 95).toFixed(2)),
    normalize_p95_ms: Number(percentile(normalizeRuns, 95).toFixed(2)),
    index_fts_p95_ms: Number(percentile(indexRuns, 95).toFixed(2))
  };

  await mkdir('.cache/bench', { recursive: true });
  await writeFile('.cache/bench/ingest.json', `${JSON.stringify(metric, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(metric)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
