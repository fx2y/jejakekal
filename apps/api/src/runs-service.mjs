import { startDefaultWorkflowRun } from './dbos-workflows.mjs';
import { getRunProjection } from './runs-projections.mjs';
import { sha256 } from '../../../packages/core/src/hash.mjs';
import { conflict } from './request-errors.mjs';
import { assertValidRunId } from './run-id.mjs';

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
 * @param {{source: string, sleepMs?: number}} params
 */
function makeInputHash(params) {
  return sha256(
    JSON.stringify({
      source: params.source,
      sleepMs: params.sleepMs ?? null
    })
  );
}

/**
 * @param {import('pg').Client} client
 * @param {string} workflowId
 * @param {string} payloadHash
 */
async function ensureWorkflowIdPayloadMatch(client, workflowId, payloadHash) {
  const result = await client.query(
    `INSERT INTO workflow_input_claims (workflow_id, payload_hash)
     VALUES ($1, $2)
     ON CONFLICT (workflow_id)
     DO UPDATE SET workflow_id = workflow_input_claims.workflow_id
     RETURNING payload_hash`,
    [workflowId, payloadHash]
  );
  const storedHash = result.rows[0]?.payload_hash;
  if (storedHash !== payloadHash) {
    throw conflict('workflow_id_payload_mismatch', { workflow_id: workflowId });
  }
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
 * @param {import('pg').Client} client
 * @param {{source: string, workflowId?: string, sleepMs?: number}} params
 */
export async function startRunDurably(client, params) {
  if (params.workflowId) {
    assertValidRunId(params.workflowId, 'workflowId');
    await ensureWorkflowIdPayloadMatch(client, params.workflowId, makeInputHash(params));
  }
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
