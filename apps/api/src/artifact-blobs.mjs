import { readFile } from 'node:fs/promises';
import { sha256 } from '../../../packages/core/src/hash.mjs';
import { resolveArtifactUriToPath } from './artifact-uri.mjs';

/**
 * @param {{uri?: string | null}} artifact
 * @param {string} bundlesRoot
 */
export function artifactBlobPath(artifact, bundlesRoot) {
  if (typeof artifact.uri !== 'string' || artifact.uri.length === 0) {
    throw new Error('artifact_blob_missing_uri');
  }
  return resolveArtifactUriToPath(bundlesRoot, artifact.uri);
}

/**
 * @param {{uri?: string | null}} artifact
 * @param {string} bundlesRoot
 */
export async function readArtifactBlob(artifact, bundlesRoot) {
  return readFile(artifactBlobPath(artifact, bundlesRoot));
}

/**
 * @param {{sha256?: string | null}} artifact
 * @param {Buffer} payload
 */
export function assertArtifactBlobHash(artifact, payload) {
  if (typeof artifact.sha256 !== 'string' || artifact.sha256.length === 0) {
    return;
  }
  if (sha256(payload) !== artifact.sha256) {
    throw new Error('artifact_blob_checksum_mismatch');
  }
}

/**
 * @param {{uri?: string | null, sha256?: string | null}} artifact
 * @param {string} bundlesRoot
 */
export async function readVerifiedArtifactBlob(artifact, bundlesRoot) {
  const payload = await readArtifactBlob(artifact, bundlesRoot);
  assertArtifactBlobHash(artifact, payload);
  return payload;
}

/**
 * @param {string} format
 * @param {Buffer} payload
 */
export function decodeArtifactContentStrict(format, payload) {
  if (format === 'application/json') {
    return JSON.parse(payload.toString('utf8'));
  }
  if (format.startsWith('text/')) {
    return payload.toString('utf8');
  }
  return payload.toString('base64');
}

/**
 * @param {Array<{uri?: string | null, sha256?: string | null}>} artifacts
 * @param {string} bundlesRoot
 */
export async function assertArtifactBlobsReadable(artifacts, bundlesRoot) {
  for (const artifact of artifacts) {
    await readVerifiedArtifactBlob(artifact, bundlesRoot);
  }
}
