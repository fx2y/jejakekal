import { startDefaultWorkflowRun } from './dbos-workflows.mjs';
import { getRunProjection } from './runs-projections.mjs';

function normalizeString(value, fallback) {
  return typeof value === 'string' ? value : fallback;
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizeSleepMs(value) {
  if (value == null) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(1, Math.floor(parsed));
}

/**
 * @param {unknown} payload
 */
export function normalizeRunStartPayload(payload) {
  const body =
    payload && typeof payload === 'object'
      ? /** @type {Record<string, unknown>} */ (payload)
      : {};
  return {
    source: normalizeString(body.source, 'default doc'),
    workflowId: normalizeOptionalString(body.workflowId),
    sleepMs: normalizeSleepMs(body.sleepMs)
  };
}

/**
 * @param {{source: string, workflowId?: string, sleepMs?: number}} params
 */
export async function startRunDurably(params) {
  const handle = await startDefaultWorkflowRun({
    workflowId: params.workflowId,
    value: params.source,
    sleepMs: params.sleepMs
  });
  return { handle, runId: handle.workflowID };
}

/**
 * @param {import('pg').Client} client
 * @param {string} runId
 */
export async function readRun(client, runId) {
  return getRunProjection(client, runId);
}

