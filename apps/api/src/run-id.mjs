import { badRequest } from './request-errors.mjs';

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * @param {string} value
 */
export function isValidRunId(value) {
  if (!RUN_ID_PATTERN.test(value)) return false;
  if (value === '.' || value === '..') return false;
  if (value.includes('/') || value.includes('\\')) return false;
  return true;
}

/**
 * @param {string} value
 * @param {string} field
 */
export function assertValidRunId(value, field = 'run_id') {
  if (!isValidRunId(value)) {
    throw badRequest('invalid_run_id', { field });
  }
  return value;
}

/**
 * @param {string} raw
 * @param {string} field
 */
export function decodeAndValidateRunId(raw, field = 'run_id') {
  let decoded = '';
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw badRequest('invalid_run_id', { field });
  }
  return assertValidRunId(decoded, field);
}
