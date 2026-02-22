const RUNS_BASE = '/runs';
const POLL_INTERVAL_MS = readQueryNumber('pollIntervalMs', 50);
const POLL_MAX_INTERVAL_MS = readQueryNumber('pollMaxIntervalMs', 750);
const POLL_TIMEOUT_MS = readQueryNumber('pollTimeoutMs', 30_000);

/**
 * @param {string} key
 * @param {number} fallback
 */
function readQueryNumber(key, fallback) {
  if (typeof window === 'undefined') return fallback;
  const raw = new URL(window.location.href).searchParams.get(key);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.floor(parsed));
}

function isTerminal(status) {
  return status === 'done' || status === 'error' || status === 'unknown';
}

/**
 * @param {{source: string, sleepMs?: number}} params
 */
export async function startRun(params) {
  const response = await fetch(RUNS_BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: params.source, sleepMs: params.sleepMs })
  });
  if (!response.ok) {
    throw new Error(`start-run-failed:${response.status}`);
  }
  return response.json();
}

/**
 * @param {string} runId
 */
export async function getRun(runId) {
  const response = await fetch(`${RUNS_BASE}/${encodeURIComponent(runId)}`);
  if (!response.ok) {
    throw new Error(`get-run-failed:${response.status}`);
  }
  return response.json();
}

/**
 * @param {string} runId
 * @param {{intervalMs?: number, maxIntervalMs?: number, timeoutMs?: number}} [opts]
 */
export async function pollRun(runId, opts = {}) {
  let intervalMs = opts.intervalMs ?? POLL_INTERVAL_MS;
  const maxIntervalMs = opts.maxIntervalMs ?? POLL_MAX_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? POLL_TIMEOUT_MS;
  const startedAt = performance.now();

  let run = await getRun(runId);
  while (!isTerminal(run.status) && performance.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    intervalMs = Math.min(maxIntervalMs, Math.ceil(intervalMs * 1.5));
    run = await getRun(runId);
  }
  return run;
}

/**
 * @param {string} runId
 */
export async function exportRun(runId) {
  const response = await fetch(`${RUNS_BASE}/${encodeURIComponent(runId)}/export`);
  if (!response.ok) {
    throw new Error(`export-run-failed:${response.status}`);
  }
  return response.json();
}
