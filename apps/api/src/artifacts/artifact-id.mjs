import { badRequest } from '../request-errors.mjs';

const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * @param {string} value
 * @param {string} field
 */
export function assertValidArtifactId(value, field = 'artifact_id') {
  if (
    !ARTIFACT_ID_PATTERN.test(value) ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\')
  ) {
    throw badRequest('invalid_artifact_id', { field });
  }
  return value;
}

/**
 * Decode raw path segment then allowlist-validate.
 * @param {string} raw
 * @param {string} field
 */
export function decodeAndValidateArtifactId(raw, field = 'artifact_id') {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw badRequest('invalid_artifact_id', { field });
  }
  let decoded = '';
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw badRequest('invalid_artifact_id', { field });
  }
  return assertValidArtifactId(decoded, field);
}
