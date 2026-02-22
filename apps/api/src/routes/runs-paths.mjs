import { decodeAndValidateRunId } from '../run-id.mjs';

/**
 * @param {string} url
 */
export function getRequestPathname(url) {
  const queryIndex = url.indexOf('?');
  return queryIndex === -1 ? url : url.slice(0, queryIndex);
}

/**
 * @param {string} pathname
 */
export function decodeRunRouteId(pathname) {
  const prefix = '/runs/';
  if (!pathname.startsWith(prefix)) return null;
  const raw = pathname.slice(prefix.length);
  if (!raw || raw.includes('/')) return null;
  return decodeAndValidateRunId(raw);
}

/**
 * @param {string} pathname
 */
export function decodeRunExportRouteId(pathname) {
  return decodeRunRouteIdWithSuffix(pathname, '/export');
}

/**
 * @param {string} pathname
 */
export function decodeRunResumeRouteId(pathname) {
  return decodeRunRouteIdWithSuffix(pathname, '/resume');
}

/**
 * @param {string} pathname
 * @param {string} suffix
 */
function decodeRunRouteIdWithSuffix(pathname, suffix) {
  const prefix = '/runs/';
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return null;
  const raw = pathname.slice(prefix.length, pathname.length - suffix.length);
  if (!raw || raw.includes('/')) return null;
  return decodeAndValidateRunId(raw);
}
