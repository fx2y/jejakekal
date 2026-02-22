import { ensureDbosRuntime } from './dbos-runtime.mjs';
import { startDefaultWorkflowRun } from './dbos-workflows.mjs';

function parseDbosCell(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && 'json' in parsed) {
      return parsed.json;
    }
    return parsed;
  } catch {
    return value;
  }
}

/**
 * @param {import('pg').Client} client
 * @param {string} workflowId
 */
export async function readWorkflowStatus(client, workflowId) {
  const res = await client.query(
    `SELECT workflow_uuid, status, name, created_at, updated_at, recovery_attempts, executor_id
     FROM dbos.workflow_status
     WHERE workflow_uuid = $1`,
    [workflowId]
  );
  if (!res.rows[0]) return null;
  const row = res.rows[0];
  return {
    workflow_uuid: row.workflow_uuid,
    status: row.status,
    name: row.name,
    created_at: row.created_at,
    updated_at: row.updated_at,
    recovery_attempts: row.recovery_attempts == null ? null : Number(row.recovery_attempts),
    executor_id: row.executor_id
  };
}

/**
 * @param {import('pg').Client} client
 * @param {string} workflowId
 */
export async function readOperationOutputs(client, workflowId) {
  const res = await client.query(
    `SELECT workflow_uuid, function_id, function_name, started_at_epoch_ms, completed_at_epoch_ms, output, error
     FROM dbos.operation_outputs
     WHERE workflow_uuid = $1
     ORDER BY function_id ASC`,
    [workflowId]
  );

  return res.rows.map((row) => ({
    workflow_uuid: row.workflow_uuid,
    function_id: Number(row.function_id),
    function_name: row.function_name,
    started_at_epoch_ms: row.started_at_epoch_ms == null ? null : Number(row.started_at_epoch_ms),
    completed_at_epoch_ms: row.completed_at_epoch_ms == null ? null : Number(row.completed_at_epoch_ms),
    output: parseDbosCell(row.output),
    error: parseDbosCell(row.error)
  }));
}

/**
 * Compatibility projection for pre-C2 `/api/timeline/*` payloads.
 * @param {import('pg').Client} client
 * @param {string} workflowId
 */
export async function readTimeline(client, workflowId) {
  const rows = await readOperationOutputs(client, workflowId);
  return rows.map((row) => ({
    index: row.function_id,
    step: row.function_name,
    phase: row.error ? 'error' : 'completed',
    payload: row.error ? { error: row.error } : (row.output ?? {}),
    output: row.error ? undefined : (row.output ?? {})
  }));
}

/**
 * @param {{client: import('pg').Client, workflowId:string, value:string}} params
 */
export async function defaultWorkflow(params) {
  await ensureDbosRuntime();
  const handle = await startDefaultWorkflowRun({ workflowId: params.workflowId, value: params.value });
  await handle.getResult();
  return readTimeline(params.client, handle.workflowID);
}

/**
 * Legacy custom-engine hook intentionally removed in C1 substrate swap.
 */
export async function runWorkflow(_params) {
  throw new Error('runWorkflow removed in C1; use DBOS-backed workflow facade');
}

export { startDefaultWorkflowRun };
