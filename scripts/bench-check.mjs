import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { checkBudgets, loadBudgets } from '../packages/core/src/perf-budget.mjs';

async function readMetric(path) {
  const payload = await readFile(path, 'utf8').catch(() => '{}');
  return JSON.parse(payload);
}

async function main() {
  const budgets = await loadBudgets('spec-0/budgets.json');
  const metrics = {
    ...(await readMetric('.cache/bench/ingest.json')),
    ...(await readMetric('.cache/bench/query.json')),
    ...(await readMetric('.cache/bench/ui.json')),
    ...(await readMetric('.cache/bench/resume.json'))
  };

  const failures = checkBudgets(budgets, metrics);

  await mkdir('.cache', { recursive: true });
  await writeFile('.cache/bench-check.stamp', `${Date.now()}\n`, 'utf8');

  if (failures.length) {
    process.stderr.write(`bench budget failures: ${failures.join(', ')}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write('bench budgets satisfied\n');
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
