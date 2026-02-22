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
 * @param {Record<string, unknown>} row
 */
export function mapWorkflowStatusRow(row) {
  return {
    workflow_uuid: String(row.workflow_uuid),
    status: String(row.status),
    name: row.name == null ? null : String(row.name),
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
    recovery_attempts:
      row.recovery_attempts == null ? null : Number(row.recovery_attempts),
    executor_id: row.executor_id == null ? null : String(row.executor_id)
  };
}

/**
 * @param {Record<string, unknown>} row
 */
export function mapOperationOutputRow(row) {
  return {
    workflow_uuid: String(row.workflow_uuid),
    function_id: Number(row.function_id),
    function_name: String(row.function_name),
    started_at_epoch_ms:
      row.started_at_epoch_ms == null ? null : Number(row.started_at_epoch_ms),
    completed_at_epoch_ms:
      row.completed_at_epoch_ms == null ? null : Number(row.completed_at_epoch_ms),
    output: parseDbosCell(row.output),
    error: parseDbosCell(row.error)
  };
}

/**
 * @param {string | null | undefined} dbosStatus
 */
export function mapDbosStatusToApiStatus(dbosStatus) {
  if (!dbosStatus) return 'unknown';
  switch (dbosStatus) {
    case 'SUCCESS':
      return 'done';
    case 'ERROR':
    case 'CANCELLED':
    case 'RETRIES_EXCEEDED':
      return 'error';
    case 'PENDING':
    case 'ENQUEUED':
    case 'RUNNING':
      return 'running';
    default:
      return 'running';
  }
}

/**
 * @param {import('pg').Client} client
 * @param {string} workflowId
 */
export async function getRunHeader(client, workflowId) {
  const res = await client.query(
    `SELECT workflow_uuid, status, name, created_at, updated_at, recovery_attempts, executor_id
     FROM dbos.workflow_status
     WHERE workflow_uuid = $1`,
    [workflowId]
  );
  if (!res.rows[0]) return null;
  return mapWorkflowStatusRow(res.rows[0]);
}

/**
 * @param {import('pg').Client} client
 * @param {string} workflowId
 */
export async function getRunSteps(client, workflowId) {
  const res = await client.query(
    `SELECT workflow_uuid, function_id, function_name, started_at_epoch_ms, completed_at_epoch_ms, output, error
     FROM dbos.operation_outputs
     WHERE workflow_uuid = $1
     ORDER BY function_id ASC`,
    [workflowId]
  );
  return res.rows.map(mapOperationOutputRow);
}

/**
 * @param {import('pg').Client} client
 * @param {string} workflowId
 */
export async function getRunProjection(client, workflowId) {
  const header = await getRunHeader(client, workflowId);
  if (!header) return null;
  const timeline = await getRunSteps(client, workflowId);
  return {
    run_id: workflowId,
    status: mapDbosStatusToApiStatus(header.status),
    dbos_status: header.status,
    header,
    timeline
  };
}

/**
 * Compatibility projection for pre-C2 `/api/timeline/*` payloads.
 * @param {Array<ReturnType<typeof mapOperationOutputRow>>} rows
 */
export function toLegacyTimeline(rows) {
  return rows.map((row) => ({
    index: row.function_id,
    step: row.function_name,
    phase: row.error ? 'error' : 'completed',
    payload: row.error ? { error: row.error } : (row.output ?? {}),
    output: row.error ? undefined : (row.output ?? {})
  }));
}

