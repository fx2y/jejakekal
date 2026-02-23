import { assertValidRunId } from '../run-id.mjs';

const HEX_64_RE = /^[a-f0-9]{64}$/;
const STEP_NAME_RE = /^[a-z0-9._:-]+$/;

/**
 * @param {unknown} value
 * @param {string} field
 */
function assertNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field}_invalid`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} field
 */
function assertPositiveInteger(value, field) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${field}_invalid`);
  }
  return value;
}

/**
 * @param {unknown} value
 */
function assertStepName(value) {
  const step = assertNonEmptyString(value, 'effect_step');
  if (!STEP_NAME_RE.test(step)) {
    throw new Error('effect_step_invalid');
  }
  return step;
}

/**
 * @param {unknown} value
 */
function assertSha256(value) {
  const sha = assertNonEmptyString(value, 'effect_sha256');
  if (!HEX_64_RE.test(sha)) {
    throw new Error('effect_sha256_invalid');
  }
  return sha;
}

/**
 * @param {{workflowId:string,step:string,docId:string,version:number,sha256:string}} params
 */
export function buildIngestEffectKey(params) {
  const workflowId = assertValidRunId(params.workflowId, 'run_id');
  const step = assertStepName(params.step);
  const docId = assertNonEmptyString(params.docId, 'doc_id');
  const version = assertPositiveInteger(params.version, 'version');
  const digest = assertSha256(params.sha256);
  return `${workflowId}|${step}|${docId}|${version}|${digest}`;
}
