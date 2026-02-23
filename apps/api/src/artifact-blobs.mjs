import { readFile } from 'node:fs/promises';
import { sha256 } from '../../../packages/core/src/hash.mjs';
import { parsePersistedArtifactUri, resolveWithinRoot } from './artifact-uri.mjs';

const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

/**
 * @param {{uri?: string | null}} artifact
 * @param {string} bundlesRoot
 */
export function artifactBlobPath(artifact, bundlesRoot) {
  if (typeof artifact.uri !== 'string' || artifact.uri.length === 0) {
    throw new Error('artifact_blob_missing_uri');
  }
  const parsed = parsePersistedArtifactUri(artifact.uri);
  if (parsed.scheme === 'bundle') {
    return resolveWithinRoot(bundlesRoot, parsed.runId, parsed.relativePath);
  }
  return `s3://${parsed.bucket}/${parsed.key}`;
}

/**
 * @param {{uri?: string | null}} artifact
 * @param {string} bundlesRoot
 * @param {{s3Store?: {getObjectBytes: (params: {bucket?: string, key: string}) => Promise<Buffer>}}} [opts]
 */
export async function readArtifactBlob(artifact, bundlesRoot, opts = {}) {
  if (typeof artifact.uri !== 'string' || artifact.uri.length === 0) {
    throw new Error('artifact_blob_missing_uri');
  }
  const parsed = parsePersistedArtifactUri(artifact.uri);
  if (parsed.scheme === 'bundle') {
    return readFile(resolveWithinRoot(bundlesRoot, parsed.runId, parsed.relativePath));
  }
  if (!opts.s3Store || typeof opts.s3Store.getObjectBytes !== 'function') {
    throw new Error('artifact_uri_scheme_not_supported');
  }
  return opts.s3Store.getObjectBytes({ bucket: parsed.bucket, key: parsed.key });
}

/**
 * @param {{sha256?: string | null}} artifact
 * @param {Buffer} payload
 */
export function assertArtifactBlobHash(artifact, payload) {
  if (typeof artifact.sha256 !== 'string' || !SHA256_HEX_RE.test(artifact.sha256)) {
    throw new Error('artifact_blob_sha256_invalid');
  }
  if (sha256(payload) !== artifact.sha256) {
    throw new Error('artifact_blob_checksum_mismatch');
  }
}

/**
 * @param {{uri?: string | null, sha256?: string | null}} artifact
 * @param {string} bundlesRoot
 * @param {{s3Store?: {getObjectBytes: (params: {bucket?: string, key: string}) => Promise<Buffer>}}} [opts]
 */
export async function readVerifiedArtifactBlob(artifact, bundlesRoot, opts = {}) {
  const payload = await readArtifactBlob(artifact, bundlesRoot, opts);
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
 * @param {{s3Store?: {getObjectBytes: (params: {bucket?: string, key: string}) => Promise<Buffer>}}} [opts]
 */
export async function assertArtifactBlobsReadable(artifacts, bundlesRoot, opts = {}) {
  for (const artifact of artifacts) {
    await readVerifiedArtifactBlob(artifact, bundlesRoot, opts);
  }
}
