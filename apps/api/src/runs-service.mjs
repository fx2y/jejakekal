import { startDefaultWorkflowRun, startHardDocWorkflowRun } from './dbos-workflows.mjs';
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
import { normalizeOcrPolicyInput, resolveOcrPolicy } from './ocr/config.mjs';

const SOURCE_INTENT_SET = new Set(SOURCE_INTENTS);
const HARDDOC_WORKFLOW_PREFIX = 'harddoc';
const PDF_MIME = 'application/pdf';

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
 * @param {Record<string, unknown>} args
 */
function normalizeSourceArgs(args) {
  const source = normalizeOptionalString(args.source);
  const locator = normalizeOptionalString(args.locator);
  const mime = normalizeOptionalString(args.mime)?.toLowerCase();
  return { source, locator, mime };
}

/**
 * @param {{intent:string,args:Record<string,unknown>}} params
 */
export function isHardDocRun(params) {
  if (!SOURCE_INTENT_SET.has(params.intent)) return false;
  const normalized = normalizeSourceArgs(params.args);
  if (normalized.mime === PDF_MIME) return true;
  const probe = `${normalized.source ?? ''} ${normalized.locator ?? ''}`;
  return /\.pdf($|\?)/i.test(probe);
}

/**
 * @param {{intent:string,args:Record<string,unknown>}} params
 */
export function deriveHardDocWorkflowId(params) {
  const digest = sha256(JSON.stringify({ intent: params.intent, args: params.args }));
  return `${HARDDOC_WORKFLOW_PREFIX}:${digest}`;
}

/**
 * Keep OCR lane timeout deterministic from policy caps and bounded for fail-closed behavior.
 * @param {{timeoutMs:number,maxPages:number}} ocrPolicy
 */
export function deriveHardDocTimeoutMs(ocrPolicy) {
  const perPage = Math.max(1_000, Number(ocrPolicy.timeoutMs ?? 120_000));
  const pageCap = Math.max(1, Number(ocrPolicy.maxPages ?? 1));
  const timeout = Math.max(30_000, 90_000 + perPage * pageCap);
  return Math.min(timeout, 3_600_000);
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
 * @param {{
 *   intent:string,
 *   args:Record<string, unknown>,
 *   workflowId?: string,
 *   ocrPolicy: {timeoutMs:number,maxPages:number}
 * }} params
 */
export function resolveWorkflowStartPlan(params) {
  const hardDoc = isHardDocRun(params);
  const workflowId = params.workflowId ?? (hardDoc ? deriveHardDocWorkflowId(params) : undefined);
  return {
    hardDoc,
    workflowId,
    timeoutMs: hardDoc ? deriveHardDocTimeoutMs(params.ocrPolicy) : undefined
  };
}

/**
 * @param {{ocrPolicy?: Record<string, unknown>}} params
 */
function resolveRunOcrPolicy(params) {
  try {
    const policy = params.ocrPolicy ? normalizeOcrPolicyInput(params.ocrPolicy) : resolveOcrPolicy(process.env);
    if (policy.engine !== 'vllm') {
      throw badRequest('invalid_run_payload', { field: 'ocrPolicy.engine' });
    }
    return policy;
  } catch (error) {
    if (error?.name === 'RequestError') {
      throw error;
    }
    if (error instanceof Error && error.message.startsWith('invalid_ocr_policy_')) {
      throw badRequest('invalid_run_payload', { field: 'ocrPolicy' });
    }
    throw error;
  }
}

/**
 * @param {import('pg').Client} client
 * @param {{intent:string, args:Record<string, unknown>, workflowId?: string, sleepMs?: number, useLlm?: boolean, bundlesRoot?: string, ocrPolicy?: Record<string, unknown>}} params
 */
export async function startRunDurably(client, params) {
  const workflowInput = toWorkflowInput(params);
  const ocrPolicy = resolveRunOcrPolicy(params);
  const startPlan = resolveWorkflowStartPlan({
    intent: params.intent,
    args: params.args,
    workflowId: params.workflowId,
    ocrPolicy
  });
  if (startPlan.workflowId) {
    assertValidRunId(startPlan.workflowId, 'workflowId');
    await ensureWorkflowIdPayloadMatch(client, startPlan.workflowId, makeInputHash(params));
  }
  const startWorkflowRun = startPlan.hardDoc ? startHardDocWorkflowRun : startDefaultWorkflowRun;
  const handle = await startWorkflowRun({
    workflowId: startPlan.workflowId,
    value: workflowInput.value,
    sleepMs: params.sleepMs,
    useLlm: params.useLlm,
    bundlesRoot: params.bundlesRoot,
    ocrPolicy,
    timeoutMs: startPlan.timeoutMs
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
