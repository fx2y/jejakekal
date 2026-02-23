import { mkdir, rm, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { ingestDocument } from '../packages/pipeline/src/ingest.mjs';

const BENCH_RUNS = 20;
const BENCH_OUT_DIR = '.cache/bench-ingest';
const BENCH_SOURCE = 'a\nb\nc';

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

async function main() {
  await rm(BENCH_OUT_DIR, { recursive: true, force: true });
  await mkdir(BENCH_OUT_DIR, { recursive: true });

  const runs = [];
  for (let i = 0; i < BENCH_RUNS; i += 1) {
    const start = performance.now();
    await ingestDocument({ docId: `bench-${i}`, source: BENCH_SOURCE, outDir: BENCH_OUT_DIR });
    runs.push(performance.now() - start);
  }

  const metric = {
    ingest_p50_ms: Number(percentile(runs, 50).toFixed(2)),
    ingest_p95_ms: Number(percentile(runs, 95).toFixed(2)),
    fts_ingest_ms: Number(percentile(runs, 95).toFixed(2))
  };

  await mkdir('.cache/bench', { recursive: true });
  await writeFile('.cache/bench/ingest.json', `${JSON.stringify(metric, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(metric)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
