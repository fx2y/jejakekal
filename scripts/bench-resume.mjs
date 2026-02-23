import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { percentile, postRun, resetBenchState, waitForRunTerminal, withApiServer } from './bench-lib.mjs';

const BENCH_RUNS = 40;

async function main() {
  await resetBenchState();
  const runs = [];
  await withApiServer(async ({ baseUrl }) => {
    const runId = await postRun(baseUrl, { source: 'bench-resume-seed', sleepMs: 10 });
    const run = await waitForRunTerminal(baseUrl, runId);
    if (run?.status !== 'done') {
      throw new Error(`bench_resume_seed_failed:${runId}`);
    }
    const route = `${baseUrl}/runs/${encodeURIComponent(runId)}/resume`;
    for (let i = 0; i < BENCH_RUNS; i += 1) {
      const start = performance.now();
      const response = await fetch(route, { method: 'POST' });
      await response.text();
      runs.push(performance.now() - start);
      if (response.status !== 409) {
        throw new Error(`bench_resume_unexpected_status:${response.status}`);
      }
    }
  });

  const metric = { resume_latency_ms: Number(percentile(runs, 95).toFixed(2)) };
  await mkdir('.cache/bench', { recursive: true });
  await writeFile('.cache/bench/resume.json', `${JSON.stringify(metric, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(metric)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
