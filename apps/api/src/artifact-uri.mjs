import { resolve, sep } from 'node:path';
import { badRequest, isRequestError } from './request-errors.mjs';
import { assertValidRunId } from './run-id.mjs';
import { assertValidArtifactId } from './artifacts/artifact-id.mjs';
const BUNDLE_URI_PREFIX = 'bundle://';
const S3_URI_PREFIX = 's3://';

export const ALLOWED_ARTIFACT_URI_SCHEMES = Object.freeze(['bundle', 's3']);
const ALLOWED_ARTIFACT_URI_SCHEME_SET = new Set(ALLOWED_ARTIFACT_URI_SCHEMES);

/**
 * @typedef {{
 *  scheme: 'bundle',
 *  runId: string,
 *  artifactId: string,
 *  relativePath: string
 * }} ParsedBundleArtifactUri
 */

/**
 * @typedef {{
 *  scheme: 's3',
 *  bucket: string,
 *  key: string
 * }} ParsedS3ArtifactUri
 */

/**
 * @param {string} value
 */
function parseBucketName(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw badRequest('invalid_artifact_uri', { field: 'artifact_uri' });
  }
  if (value === '.' || value === '..' || value.includes('/') || value.includes('\\')) {
    throw badRequest('invalid_artifact_uri', { field: 'artifact_uri' });
  }
  return value;
}

/**
 * @param {string} uri
 */
export function parseArtifactUriScheme(uri) {
  if (typeof uri !== 'string' || uri.length === 0) {
    throw badRequest('invalid_artifact_uri', { field: 'artifact_uri' });
  }
  const marker = uri.indexOf('://');
  if (marker <= 0) {
    throw badRequest('invalid_artifact_uri', { field: 'artifact_uri' });
  }
  const scheme = uri.slice(0, marker).toLowerCase();
  if (!ALLOWED_ARTIFACT_URI_SCHEME_SET.has(scheme)) {
    throw badRequest('invalid_artifact_uri', { field: 'artifact_uri' });
  }
  return scheme;
}

/**
 * @param {string} value
 */
function parseRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw badRequest('invalid_artifact_uri', { field: 'artifact_uri' });
  }
  const segments = value.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || segment.includes('\\')) {
      throw badRequest('invalid_artifact_uri', { field: 'artifact_uri' });
    }
  }
  return segments.join('/');
}

/**
 * @param {string} root
 * @param {...string} parts
 */
export function resolveWithinRoot(root, ...parts) {
  const rootPath = resolve(root);
  const targetPath = resolve(rootPath, ...parts);
  if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath}${sep}`)) {
    throw badRequest('invalid_run_id', { field: 'run_id' });
  }
  return targetPath;
}

/**
 * Canonical v0 artifact URI shape for bundle-root storage.
 * @param {{runId: string, artifactId: string, relativePath: string}} params
 */
export function makeBundleArtifactUri(params) {
  const runId = assertValidRunId(params.runId, 'run_id');
  const artifactId = assertValidArtifactId(params.artifactId);
  const relativePath = parseRelativePath(params.relativePath);
  return `${BUNDLE_URI_PREFIX}${encodeURIComponent(runId)}/${encodeURIComponent(artifactId)}/${relativePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')}`;
}

/**
 * @param {string} uri
 */
export function parseBundleArtifactUri(uri) {
  if (typeof uri !== 'string' || !uri.startsWith(BUNDLE_URI_PREFIX)) {
    throw badRequest('invalid_artifact_uri', { field: 'artifact_uri' });
  }
  const rawRest = uri.slice(BUNDLE_URI_PREFIX.length);
  const [rawRunId = '', rawArtifactId = '', ...rawSegments] = rawRest.split('/');
  if (!rawRunId || !rawArtifactId || rawSegments.length === 0) {
    throw badRequest('invalid_artifact_uri', { field: 'artifact_uri' });
  }

  let runId = '';
  let artifactId = '';
  let relativePath = '';
  try {
    runId = decodeURIComponent(rawRunId);
    artifactId = decodeURIComponent(rawArtifactId);
    relativePath = rawSegments.map((segment) => decodeURIComponent(segment)).join('/');
  } catch {
    throw badRequest('invalid_artifact_uri', { field: 'artifact_uri' });
  }

  return {
    runId: assertValidRunId(runId, 'run_id'),
    artifactId: assertValidArtifactId(artifactId),
    relativePath: parseRelativePath(relativePath)
  };
}

/**
 * @param {string} uri
 */
export function parseS3ArtifactUri(uri) {
  if (typeof uri !== 'string' || !uri.startsWith(S3_URI_PREFIX)) {
    throw badRequest('invalid_artifact_uri', { field: 'artifact_uri' });
  }
  const rawRest = uri.slice(S3_URI_PREFIX.length);
  const [rawBucket = '', ...rawKeySegments] = rawRest.split('/');
  if (!rawBucket || rawKeySegments.length === 0) {
    throw badRequest('invalid_artifact_uri', { field: 'artifact_uri' });
  }
  let bucket = '';
  let key = '';
  try {
    bucket = decodeURIComponent(rawBucket);
    key = rawKeySegments.map((segment) => decodeURIComponent(segment)).join('/');
  } catch {
    throw badRequest('invalid_artifact_uri', { field: 'artifact_uri' });
  }
  return {
    bucket: parseBucketName(bucket),
    key: parseRelativePath(key)
  };
}

/**
 * @param {string} uri
 * @returns {ParsedBundleArtifactUri | ParsedS3ArtifactUri}
 */
export function parseArtifactUri(uri) {
  const scheme = parseArtifactUriScheme(uri);
  if (scheme === 'bundle') {
    return /** @type {ParsedBundleArtifactUri} */ ({
      scheme: 'bundle',
      ...parseBundleArtifactUri(uri)
    });
  }
  return /** @type {ParsedS3ArtifactUri} */ ({
    scheme: 's3',
    ...parseS3ArtifactUri(uri)
  });
}

/**
 * Strict parser for persisted `artifact.uri` rows.
 * Persisted-row decode failures are server invariant violations, not client 4xx.
 * @param {string} uri
 * @returns {ParsedBundleArtifactUri | ParsedS3ArtifactUri}
 */
export function parsePersistedArtifactUri(uri) {
  try {
    return parseArtifactUri(uri);
  } catch (error) {
    if (isRequestError(error)) {
      throw new Error('artifact_uri_invalid_persisted');
    }
    throw error;
  }
}

/**
 * @param {string} bundlesRoot
 * @param {string} uri
 */
export function resolveBundleArtifactUri(bundlesRoot, uri) {
  const parsed = parseBundleArtifactUri(uri);
  return resolveWithinRoot(bundlesRoot, parsed.runId, parsed.relativePath);
}

/**
 * @param {string} bundlesRoot
 * @param {string} uri
 * @param {{resolveS3Uri?: (parsed: ParsedS3ArtifactUri) => string}} [opts]
 */
export function resolveArtifactUriToPath(bundlesRoot, uri, opts = {}) {
  const parsed = parseArtifactUri(uri);
  if (parsed.scheme === 'bundle') {
    return resolveWithinRoot(bundlesRoot, parsed.runId, parsed.relativePath);
  }
  if (typeof opts.resolveS3Uri === 'function') {
    return opts.resolveS3Uri(parsed);
  }
  throw new Error('artifact_uri_scheme_not_supported');
}
