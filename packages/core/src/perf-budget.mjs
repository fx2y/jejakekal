import { readFile } from 'node:fs/promises';

/**
 * @param {string} path
 */
export async function loadBudgets(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

/**
 * @param {Record<string, number>} budgets
 * @param {Record<string, number>} metrics
 */
export function checkBudgets(budgets, metrics) {
  /** @type {string[]} */
  const failures = [];
  for (const [name, budget] of Object.entries(budgets)) {
    const measured = metrics[name];
    if (measured === undefined) {
      failures.push(`${name}:missing`);
      continue;
    }
    if (measured > budget) {
      failures.push(`${name}:${measured}>${budget}`);
    }
  }
  return failures;
}
