import { startDefaultWorkflowRun } from './dbos-workflows.mjs';
import { getRunProjection } from './runs-projections.mjs';
import { sha256 } from '../../../packages/core/src/hash.mjs';
import { badRequest, conflict } from './request-errors.mjs';
import { assertValidRunId } from './run-id.mjs';
import {
  SOURCE_INTENTS,
  commandToWorkflowValue,
  parseIntentPayload,
  parseSlashCommand
} from './commands/parse-command.mjs';
import {
  assertSourceCompatAllowed,
  recordSourceCompatUsage,
  resolveCompatToday,
  resolveSourceCompatUntil
} from './source-compat.mjs';

const SOURCE_INTENT_SET = new Set(SOURCE_INTENTS);

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizeSleepMs(value) {
  if (value == null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw badRequest('invalid_run_payload');
  }
  return value;
}

function normalizeUseLlm(value) {
  if (value == null) return undefined;
  if (typeof value !== 'boolean') {
    throw badRequest('invalid_run_payload');
  }
  return value;
}

/**
 * @param {{intent: string, args: Record<string, unknown>, sleepMs?: number, useLlm?: boolean}} params
 */
function makeInputHash(params) {
  return sha256(
    JSON.stringify({
      intent: params.intent,
      args: params.args
    })
  );
}

/**
 * @param {{intent:string, cmd:string, args:Record<string, unknown>}} command
 */
function assertSourceIntentCommand(command) {
  if (!SOURCE_INTENT_SET.has(command.intent)) {
    throw badRequest('invalid_command', { cmd: command.cmd });
  }
  return command;
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
  const workflowId = normalizeOptionalString(body.workflowId);
  const sleepMs = normalizeSleepMs(body.sleepMs);
  const useLlm = normalizeUseLlm(body.useLlm);
  if (typeof body.cmd === 'string') {
    const parsed = assertSourceIntentCommand(parseSlashCommand(body.cmd));
    return { ...parsed, workflowId, sleepMs, useLlm, compat: false };
  }
  if (typeof body.intent === 'string') {
    const parsed = assertSourceIntentCommand(parseIntentPayload(body));
    return { ...parsed, workflowId, sleepMs, useLlm, compat: false };
  }
  if (typeof body.source === 'string' && body.source.trim().length > 0) {
    const today = resolveCompatToday();
    const until = resolveSourceCompatUntil();
    assertSourceCompatAllowed(today, until);
    recordSourceCompatUsage({ today, until });
    return {
      cmd: '/doc',
      intent: 'doc',
      args: { source: body.source.trim() },
      workflowId,
      sleepMs,
      useLlm,
      compat: true
    };
  }
  throw badRequest('invalid_run_payload');
}

/**
 * @param {{intent:string, args:Record<string, unknown>}} command
 */
function toWorkflowInput(command) {
  return {
    value: commandToWorkflowValue(command)
  };
}

/**
 * @param {import('pg').Client} client
 * @param {{intent:string, args:Record<string, unknown>, workflowId?: string, sleepMs?: number, useLlm?: boolean, bundlesRoot?: string}} params
 */
export async function startRunDurably(client, params) {
  const workflowInput = toWorkflowInput(params);
  if (params.workflowId) {
    assertValidRunId(params.workflowId, 'workflowId');
    await ensureWorkflowIdPayloadMatch(client, params.workflowId, makeInputHash(params));
  }
  const handle = await startDefaultWorkflowRun({
    workflowId: params.workflowId,
    value: workflowInput.value,
    sleepMs: params.sleepMs,
    useLlm: params.useLlm,
    bundlesRoot: params.bundlesRoot
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
