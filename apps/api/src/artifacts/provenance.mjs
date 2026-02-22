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
 * Enforce IDs+hashes-only provenance for artifact rows.
 * @param {{runId:string, artifactType:string, artifactSha256:string, sourceSha256:string, producerStep?:string, inputs?:Array<{kind:string,id?:string,sha256?:string}>}} params
 */
export function buildArtifactProvenance(params) {
  const runId = assertValidRunId(params.runId, 'run_id');
  const artifactType = assertValidArtifactId(params.artifactType, 'artifact_type');
  const artifactSha256 = assertSha(params.artifactSha256, 'artifact_sha256');
  const sourceSha256 = assertSha(params.sourceSha256, 'source_sha256');
  const producerStep = typeof params.producerStep === 'string' && params.producerStep ? params.producerStep : 'persist-artifacts';
  const inputs = Array.isArray(params.inputs) ? params.inputs : [];

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
    }))
  };
}

/**
 * @param {string} source
 */
export function hashSource(source) {
  return sha256(String(source));
}
