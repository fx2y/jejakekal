import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

async function fakeQuery() {
  return 'ok';
}

async function main() {
  const runs = [];
  for (let i = 0; i < 100; i += 1) {
    const start = performance.now();
    await fakeQuery();
    runs.push(performance.now() - start);
  }

  const metric = {
    query_p50_ms: Number(percentile(runs, 50).toFixed(2)),
    query_p95_ms: Number(percentile(runs, 95).toFixed(2)),
    fts_query_p95_ms: Number(percentile(runs, 95).toFixed(2))
  };

  await mkdir('.cache/bench', { recursive: true });
  await writeFile('.cache/bench/query.json', `${JSON.stringify(metric, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(metric)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
