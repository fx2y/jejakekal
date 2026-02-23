import { sha256 } from '../../../../packages/core/src/hash.mjs';
import { assertValidRunId } from '../run-id.mjs';
import { assertValidArtifactId } from './artifact-id.mjs';

const HASH_PATTERN = /^[a-f0-9]{64}$/;

/**
 * @param {string} value
 * @param {string} field
 */
function assertSha(value, field) {
  if (!HASH_PATTERN.test(value)) {
    throw new Error(`invalid_${field}`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function assertObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_object');
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * Enforce IDs+hashes-only provenance for artifact rows.
 * @param {{runId:string, artifactType:string, artifactSha256:string, sourceSha256:string, producerStep?:string, inputs?:Array<{kind:string,id?:string,sha256?:string}>, parser?:Record<string, unknown>, objectKeys?:{raw?:string,parse?:string[],assets?:Array<{key:string,sha256:string}>}}} params
 */
export function buildArtifactProvenance(params) {
  const runId = assertValidRunId(params.runId, 'run_id');
  const artifactType = assertValidArtifactId(params.artifactType, 'artifact_type');
  const artifactSha256 = assertSha(params.artifactSha256, 'artifact_sha256');
  const sourceSha256 = assertSha(params.sourceSha256, 'source_sha256');
  const producerStep = typeof params.producerStep === 'string' && params.producerStep ? params.producerStep : 'persist-artifacts';
  const inputs = Array.isArray(params.inputs) ? params.inputs : [];

  const parser =
    params.parser && typeof params.parser === 'object'
      ? (() => {
          const value = assertObject(params.parser);
          return {
            ...(typeof value.engine === 'string' ? { engine: value.engine } : {}),
            ...(typeof value.version === 'string' ? { version: value.version } : {}),
            ...(typeof value.mode === 'string' ? { mode: value.mode } : {}),
            ...(typeof value.marker_cfg_sha === 'string'
              ? { marker_cfg_sha: assertSha(value.marker_cfg_sha, 'marker_cfg_sha') }
              : {}),
            ...(typeof value.stdout_sha256 === 'string'
              ? { stdout_sha256: assertSha(value.stdout_sha256, 'stdout_sha256') }
              : {}),
            ...(typeof value.stderr_sha256 === 'string'
              ? { stderr_sha256: assertSha(value.stderr_sha256, 'stderr_sha256') }
              : {}),
            ...(typeof value.timing_ms === 'number' && Number.isFinite(value.timing_ms)
              ? { timing_ms: Math.max(0, Math.trunc(value.timing_ms)) }
              : {}),
            ...(typeof value.use_llm === 'number' ? { use_llm: value.use_llm } : {})
          };
        })()
      : null;
  const object_keys =
    params.objectKeys && typeof params.objectKeys === 'object'
      ? {
          ...(typeof params.objectKeys.raw === 'string' ? { raw: params.objectKeys.raw } : {}),
          ...(Array.isArray(params.objectKeys.parse)
            ? { parse: params.objectKeys.parse.map((key) => String(key)) }
            : {}),
          ...(Array.isArray(params.objectKeys.assets)
            ? {
                assets: params.objectKeys.assets.map((asset) => ({
                  key: String(asset.key),
                  sha256: assertSha(String(asset.sha256), 'asset_sha256')
                }))
              }
            : {})
        }
      : null;

  return {
    version: 1,
    run_id: runId,
    artifact_type: artifactType,
    producer_step: producerStep,
    hash: {
      artifact_sha256: artifactSha256,
      source_sha256: sourceSha256
    },
    inputs: inputs.map((input) => ({
      kind: String(input.kind),
      ...(typeof input.id === 'string' ? { id: String(input.id) } : {}),
      ...(typeof input.sha256 === 'string' ? { sha256: assertSha(input.sha256, 'input_sha256') } : {})
    })),
    ...(parser ? { parser } : {}),
    ...(object_keys ? { object_keys } : {})
  };
}

/**
 * @param {string} source
 */
export function hashSource(source) {
  return sha256(String(source));
}
