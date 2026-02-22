import { resolve, sep } from 'node:path';
import { badRequest } from './request-errors.mjs';
import { assertValidRunId } from './run-id.mjs';
import { assertValidArtifactId } from './artifacts/artifact-id.mjs';
const BUNDLE_URI_PREFIX = 'bundle://';

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
 * @param {string} bundlesRoot
 * @param {string} uri
 */
export function resolveBundleArtifactUri(bundlesRoot, uri) {
  const parsed = parseBundleArtifactUri(uri);
  return resolveWithinRoot(bundlesRoot, parsed.runId, parsed.relativePath);
}
