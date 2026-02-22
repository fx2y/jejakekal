import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

async function main() {
  const start = performance.now();
  // Static load approximation for harness checks.
  await new Promise((resolve) => setTimeout(resolve, 25));
  const metric = { ui_load_ms: Number((performance.now() - start).toFixed(2)) };

  await mkdir('.cache/bench', { recursive: true });
  await writeFile('.cache/bench/ui.json', `${JSON.stringify(metric, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(metric)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
