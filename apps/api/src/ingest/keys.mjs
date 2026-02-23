import { basename } from 'node:path';
import { sha256 } from '../../../../packages/core/src/hash.mjs';
import { assertValidRunId } from '../run-id.mjs';
import { assertValidArtifactId } from '../artifacts/artifact-id.mjs';
import { assertFrozenArtifactType } from '../contracts.mjs';

const HEX_64_RE = /^[a-f0-9]{64}$/;
const KEY_SEGMENT_RE = /^[A-Za-z0-9._:-]+$/;
const OBJECT_KEY_PREFIXES = new Set(['raw', 'parse', 'asset', 'run']);
const PARSE_BLOB_FILENAMES = new Set(['marker.json', 'marker.md', 'chunks.json']);
const MAX_ARTIFACT_ID_LENGTH = 128;
const ARTIFACT_ID_HASH_LEN = 16;

const INGEST_ARTIFACT_META = Object.freeze({
  raw: Object.freeze({ format: 'text/plain', title: 'Raw Source', pathKey: 'raw' }),
  docir: Object.freeze({ format: 'application/json', title: 'DocIR', pathKey: 'docir' }),
  'chunk-index': Object.freeze({
    format: 'application/json',
    title: 'Chunk Index',
    pathKey: 'chunkIndex'
  }),
  memo: Object.freeze({ format: 'text/markdown', title: 'Pipeline Memo', pathKey: 'memo' })
});

/**
 * @param {unknown} value
 * @param {string} field
 */
function assertLowerHexSha256(value, field) {
  if (typeof value !== 'string' || !HEX_64_RE.test(value)) {
    throw new Error(`${field}_invalid`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} field
 */
function assertKeySegment(value, field) {
  if (typeof value !== 'string' || value.length === 0 || !KEY_SEGMENT_RE.test(value)) {
    throw new Error(`${field}_invalid`);
  }
  if (value === '.' || value === '..') {
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
 * @param {string[]} segments
 */
function buildObjectKey(segments) {
  for (const segment of segments) {
    if (!segment || segment.includes('/')) {
      throw new Error('object_key_invalid');
    }
  }
  return segments.join('/');
}

/**
 * @param {string} key
 */
export function assertAllowedObjectKey(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('object_key_invalid');
  }
  const segments = key.split('/');
  if (segments.length < 2) {
    throw new Error('object_key_invalid');
  }
  const [prefix, ...rest] = segments;
  if (!OBJECT_KEY_PREFIXES.has(prefix)) {
    throw new Error('object_key_invalid');
  }
  for (const segment of rest) {
    assertKeySegment(segment, 'object_key_segment');
  }
  return key;
}

/**
 * @param {string} rawSha
 */
export function buildRawObjectKey(rawSha) {
  return buildObjectKey(['raw', 'sha256', assertLowerHexSha256(rawSha, 'raw_sha256')]);
}

/**
 * @param {{docId: string, version: number, filename: string}} params
 */
export function buildParseObjectKey(params) {
  const docId = assertKeySegment(params.docId, 'doc_id');
  const version = assertPositiveInteger(params.version, 'version');
  if (!PARSE_BLOB_FILENAMES.has(params.filename)) {
    throw new Error('parse_filename_invalid');
  }
  return buildObjectKey(['parse', docId, String(version), params.filename]);
}

/**
 * @param {string} assetSha
 */
export function buildAssetObjectKey(assetSha) {
  return buildObjectKey(['asset', 'sha256', assertLowerHexSha256(assetSha, 'asset_sha256')]);
}

/**
 * @param {{runId: string, relativePath: string}} params
 */
export function buildRunObjectKey(params) {
  const runId = assertKeySegment(params.runId, 'run_id');
  const relativePath = params.relativePath.split('/');
  if (relativePath.length === 0) {
    throw new Error('run_relative_path_invalid');
  }
  const normalized = relativePath.map((segment) => assertKeySegment(segment, 'run_relative_path'));
  return buildObjectKey(['run', runId, ...normalized]);
}

/**
 * @param {string} runId
 * @param {'raw'|'docir'|'chunk-index'|'memo'} type
 */
export function makeRunArtifactId(runId, type) {
  const validRunId = assertValidRunId(runId, 'run_id');
  const validType = assertFrozenArtifactType(type);
  const fullArtifactId = `${validRunId}:${validType}`;
  if (fullArtifactId.length <= MAX_ARTIFACT_ID_LENGTH) {
    return assertValidArtifactId(fullArtifactId);
  }
  const runHash = sha256(validRunId).slice(0, ARTIFACT_ID_HASH_LEN);
  const typeSuffix = `:${validType}`;
  const hashSuffix = `.${runHash}`;
  const runHeadBudget = Math.max(
    1,
    MAX_ARTIFACT_ID_LENGTH - typeSuffix.length - hashSuffix.length
  );
  const runHead = validRunId.slice(0, runHeadBudget);
  const artifactId = `${runHead}${hashSuffix}${typeSuffix}`;
  return assertValidArtifactId(artifactId);
}

/**
 * @param {string} filePath
 */
export function makeIngestRelativePath(filePath) {
  return `ingest/${basename(filePath)}`;
}

/**
 * @param {{workflowId: string, paths: {raw:string,docir:string,chunkIndex:string,memo:string}}} params
 */
export function buildPersistedIngestArtifactPlan(params) {
  const types = /** @type {Array<'raw'|'docir'|'chunk-index'|'memo'>} */ ([
    'raw',
    'docir',
    'chunk-index',
    'memo'
  ]);
  return types.map((type) => {
    const meta = INGEST_ARTIFACT_META[type];
    const sourcePath = params.paths[meta.pathKey];
    if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
      throw new Error('ingest_artifact_path_missing');
    }
    return {
      type,
      format: meta.format,
      title: meta.title,
      sourcePath,
      artifactId: makeRunArtifactId(params.workflowId, type),
      relativePath: makeIngestRelativePath(sourcePath)
    };
  });
}
