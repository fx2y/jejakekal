import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { startUiServer } from '../apps/ui/src/server.mjs';
import { percentile, postRun, resetBenchState, waitForRunTerminal } from './bench-lib.mjs';

const BENCH_RUNS = 40;

async function main() {
  await resetBenchState();
  const runtime = await startUiServer(0, { apiPort: 0 });
  try {
    const uiBaseUrl = `http://127.0.0.1:${runtime.uiPort}`;
    const apiBaseUrl = `http://127.0.0.1:${runtime.apiPort}`;
    const seedRunId = await postRun(apiBaseUrl, { source: 'bench-ui-seed', sleepMs: 10 });
    const run = await waitForRunTerminal(apiBaseUrl, seedRunId);
    if (run?.status !== 'done') {
      throw new Error(`bench_ui_seed_failed:${seedRunId}`);
    }

    const route = `${uiBaseUrl}/runs/${encodeURIComponent(seedRunId)}`;
    const runs = [];
    for (let i = 0; i < BENCH_RUNS; i += 1) {
      const start = performance.now();
      const response = await fetch(route);
      const html = await response.text();
      runs.push(performance.now() - start);
      if (!response.ok || !html.includes('id="main"')) {
        throw new Error(`bench_ui_route_failed:${response.status}`);
      }
    }

    const metric = { ui_load_ms: Number(percentile(runs, 95).toFixed(2)) };
    await mkdir('.cache/bench', { recursive: true });
    await writeFile('.cache/bench/ui.json', `${JSON.stringify(metric, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(metric)}\n`);
  } finally {
    await runtime.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
