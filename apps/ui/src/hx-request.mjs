/**
 * @param {import('node:http').IncomingHttpHeaders} headers
 * @param {string} name
 */
function readHeader(headers, name) {
  const raw = headers[name];
  if (Array.isArray(raw)) return raw[0] ?? '';
  return raw ?? '';
}

/**
 * @param {import('node:http').IncomingHttpHeaders} headers
 */
export function isHxRequest(headers) {
  return readHeader(headers, 'hx-request') === 'true';
}

/**
 * @param {import('node:http').IncomingHttpHeaders} headers
 */
export function isHxHistoryRestoreRequest(headers) {
  return readHeader(headers, 'hx-history-restore-request') === 'true';
}

/**
 * C0 seam probe for server-driven render split:
 * full document for non-HX or history-restore; fragment for regular HX.
 * @param {import('node:http').IncomingHttpHeaders} headers
 */
export function shouldServeFullDocument(headers) {
  return !isHxRequest(headers) || isHxHistoryRestoreRequest(headers);
}
