import { listArtifactsByRunId, toArtifactListItem } from './artifacts/repository.mjs';

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
 * @param {unknown} output
 */
function readAttempt(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return 1;
  const raw = /** @type {Record<string, unknown>} */ (output).attempt;
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.trunc(parsed));
}

/**
 * @param {Array<ReturnType<typeof import('./artifacts/repository.mjs').mapArtifactRow>>} artifacts
 */
function buildStepHints(artifacts) {
  const hashesByStep = new Map();
  const costByStep = new Map();
  for (const artifact of artifacts) {
    const prov = artifact.prov && typeof artifact.prov === 'object' ? artifact.prov : {};
    const producerStep = typeof prov.producer_step === 'string' ? prov.producer_step : null;
    if (!producerStep) continue;
    const hash = prov.hash && typeof prov.hash === 'object' ? prov.hash : {};
    const artifactHash =
      typeof hash.artifact_sha256 === 'string' && hash.artifact_sha256.length > 0
        ? hash.artifact_sha256
        : null;
    const sourceHash =
      typeof hash.source_sha256 === 'string' && hash.source_sha256.length > 0 ? hash.source_sha256 : null;
    const hashes = hashesByStep.get(producerStep) ?? new Set();
    if (artifactHash) hashes.add(artifactHash);
    if (sourceHash) hashes.add(sourceHash);
    hashesByStep.set(producerStep, hashes);
    if (!costByStep.has(producerStep) && prov.cost != null) {
      costByStep.set(producerStep, prov.cost);
    }
  }
  return { hashesByStep, costByStep };
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
  const startedAt = row.started_at_epoch_ms == null ? null : Number(row.started_at_epoch_ms);
  const completedAt = row.completed_at_epoch_ms == null ? null : Number(row.completed_at_epoch_ms);
  const output = parseDbosCell(row.output);
  const error = parseDbosCell(row.error);
  return {
    workflow_uuid: String(row.workflow_uuid),
    function_id: Number(row.function_id),
    function_name: String(row.function_name),
    started_at_epoch_ms: startedAt,
    completed_at_epoch_ms: completedAt,
    duration_ms:
      startedAt == null || completedAt == null ? null : Math.max(0, Math.trunc(completedAt - startedAt)),
    attempt: readAttempt(output),
    output,
    error
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
      return 'unknown';
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
  const baseTimeline = await getRunSteps(client, workflowId);
  const artifacts = await listArtifactsByRunId(client, workflowId);
  const functionIdByName = new Map(baseTimeline.map((row) => [row.function_name, row.function_id]));
  const { hashesByStep, costByStep } = buildStepHints(artifacts);
  const timeline = baseTimeline.map((row) => ({
    ...row,
    io_hashes: [...(hashesByStep.get(row.function_name) ?? new Set())].sort(),
    cost: costByStep.get(row.function_name) ?? null
  }));
  const projectedArtifacts = artifacts.map((artifact) => {
    const prov = artifact.prov && typeof artifact.prov === 'object' ? artifact.prov : {};
    const producerStep = typeof prov.producer_step === 'string' ? prov.producer_step : null;
    const producerFunctionId =
      producerStep != null && functionIdByName.has(producerStep)
        ? functionIdByName.get(producerStep)
        : null;
    return toArtifactListItem({
      ...artifact,
      prov:
        producerFunctionId == null
          ? prov
          : {
              ...prov,
              producer_function_id: producerFunctionId
            }
    });
  });
  return {
    run_id: workflowId,
    status: mapDbosStatusToApiStatus(header.status),
    dbos_status: header.status,
    header,
    timeline,
    artifacts: projectedArtifacts
  };
}

/**
 * Bundle/export timeline projection.
 * @param {Array<ReturnType<typeof mapOperationOutputRow>>} rows
 */
export function toBundleTimeline(rows) {
  return rows.map((row) => ({
    index: row.function_id,
    step: row.function_name,
    phase: row.error ? 'error' : 'completed',
    payload: row.error ? { error: row.error } : (row.output ?? {}),
    output: row.error ? undefined : (row.output ?? {})
  }));
}
