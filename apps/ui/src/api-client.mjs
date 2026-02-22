const RUNS_BASE = '/runs';
const POLL_INTERVAL_MS = 25;
const POLL_MAX_ATTEMPTS = 200;

function isTerminal(status) {
  return status === 'done' || status === 'error';
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
 * @param {{intervalMs?: number, maxAttempts?: number}} [opts]
 */
export async function pollRun(runId, opts = {}) {
  const intervalMs = opts.intervalMs ?? POLL_INTERVAL_MS;
  const maxAttempts = opts.maxAttempts ?? POLL_MAX_ATTEMPTS;

  let run = await getRun(runId);
  for (let i = 0; i < maxAttempts && !isTerminal(run.status); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
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
