import { startApiServer } from '../apps/api/src/server.mjs';
import { makeClient, resetAppTables } from '../apps/api/src/db.mjs';

/**
 * @param {number[]} values
 * @param {number} p
 */
export function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

/**
 * @param {Response} response
 */
async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  return JSON.parse(text);
}

/**
 * @param {string} baseUrl
 * @param {Record<string, unknown>} payload
 */
export async function postRun(baseUrl, payload) {
  const startRes = await fetch(`${baseUrl}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!startRes.ok) {
    const body = await readJsonResponse(startRes).catch(() => ({}));
    throw new Error(`bench_start_failed:${startRes.status}:${String(body?.error ?? 'unknown')}`);
  }
  const started = await readJsonResponse(startRes);
  if (typeof started.run_id !== 'string' || started.run_id.length === 0) {
    throw new Error('bench_start_missing_run_id');
  }
  return started.run_id;
}

/**
 * @param {string} baseUrl
 * @param {string} runId
 * @param {{timeoutMs?: number, intervalMs?: number}} [opts]
 */
export async function waitForRunTerminal(baseUrl, runId, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs ?? 20_000);
  const intervalMs = Number(opts.intervalMs ?? 50);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const runRes = await fetch(`${baseUrl}/runs/${encodeURIComponent(runId)}`);
    if (!runRes.ok) {
      throw new Error(`bench_run_read_failed:${runRes.status}`);
    }
    const run = await readJsonResponse(runRes);
    if (run?.status === 'done' || run?.status === 'error') {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`bench_run_timeout:${runId}`);
}

export async function resetBenchState() {
  const client = makeClient();
  await client.connect();
  try {
    await resetAppTables(client);
  } finally {
    await client.end();
  }
}

/**
 * @template T
 * @param {(ctx: {baseUrl: string, api: Awaited<ReturnType<typeof startApiServer>>}) => Promise<T>} run
 */
export async function withApiServer(run) {
  const api = await startApiServer(0);
  try {
    const baseUrl = `http://127.0.0.1:${api.port}`;
    return await run({ baseUrl, api });
  } finally {
    await api.close();
  }
}
