import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

async function main() {
  const start = performance.now();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const metric = { resume_latency_ms: Number((performance.now() - start).toFixed(2)) };

  await mkdir('.cache/bench', { recursive: true });
  await writeFile('.cache/bench/resume.json', `${JSON.stringify(metric, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(metric)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
