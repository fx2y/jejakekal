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
 * @param {string} field
 */
function assertNonNegativeInteger(value, field) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
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

/**
 * @param {{workflowId:string,docId:string,version:number,pageIdx:number,pngSha256:string}} params
 */
export function buildOcrPageRenderEffectKey(params) {
  const workflowId = assertValidRunId(params.workflowId, 'run_id');
  const docId = assertNonEmptyString(params.docId, 'doc_id');
  const version = assertPositiveInteger(params.version, 'version');
  const pageIdx = assertNonNegativeInteger(params.pageIdx, 'page_idx');
  const digest = assertSha256(params.pngSha256);
  return `${workflowId}|ocr-render-page|${docId}|${version}|p${pageIdx}|${digest}`;
}

/**
 * @param {{workflowId:string,docId:string,version:number,pageIdx:number,model:string,gateRev:string,pngSha256:string}} params
 */
export function buildOcrPageEffectKey(params) {
  const workflowId = assertValidRunId(params.workflowId, 'run_id');
  const docId = assertNonEmptyString(params.docId, 'doc_id');
  const version = assertPositiveInteger(params.version, 'version');
  const pageIdx = assertNonNegativeInteger(params.pageIdx, 'page_idx');
  const model = assertNonEmptyString(params.model, 'ocr_model');
  const gateRev = assertNonEmptyString(params.gateRev, 'gate_rev');
  const digest = assertSha256(params.pngSha256);
  return `${workflowId}|ocr-page|${docId}|${version}|p${pageIdx}|${model}|${gateRev}|${digest}`;
}

/**
 * @param {{workflowId:string,docId:string,version:number,blockSha256:string,model:string}} params
 */
export function buildEmbeddingBlockEffectKey(params) {
  const workflowId = assertValidRunId(params.workflowId, 'run_id');
  const docId = assertNonEmptyString(params.docId, 'doc_id');
  const version = assertPositiveInteger(params.version, 'version');
  const model = assertNonEmptyString(params.model, 'embedding_model');
  const digest = assertSha256(params.blockSha256);
  return `${workflowId}|embed-block|${docId}|${version}|${model}|${digest}`;
}
