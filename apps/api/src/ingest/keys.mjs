import { basename } from 'node:path';
import { assertValidRunId } from '../run-id.mjs';
import { assertValidArtifactId } from '../artifacts/artifact-id.mjs';
import { assertFrozenArtifactType } from '../contracts.mjs';

const INGEST_ARTIFACT_META = Object.freeze({
  raw: Object.freeze({ format: 'text/plain', title: 'Raw Source', pathKey: 'raw' }),
  docir: Object.freeze({ format: 'application/json', title: 'DocIR', pathKey: 'docir' }),
  'chunk-index': Object.freeze({
    format: 'application/json',
    title: 'Chunk Index',
    pathKey: 'chunkIndex'
  }),
  memo: Object.freeze({ format: 'application/json', title: 'Pipeline Memo', pathKey: 'memo' })
});

/**
 * @param {string} runId
 * @param {'raw'|'docir'|'chunk-index'|'memo'} type
 */
export function makeRunArtifactId(runId, type) {
  const validRunId = assertValidRunId(runId, 'run_id');
  const validType = assertFrozenArtifactType(type);
  const artifactId = `${validRunId}:${validType}`;
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
