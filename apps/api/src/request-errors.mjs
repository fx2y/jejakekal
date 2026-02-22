export class RequestError extends Error {
  /**
   * @param {number} status
   * @param {Record<string, unknown>} payload
   */
  constructor(status, payload) {
    super(typeof payload.error === 'string' ? payload.error : 'request_error');
    this.name = 'RequestError';
    this.status = status;
    this.payload = payload;
  }
}

/**
 * @param {unknown} error
 */
export function isRequestError(error) {
  return error instanceof RequestError;
}

/**
 * @param {string} code
 * @param {Record<string, unknown>} [extra]
 */
export function badRequest(code, extra = {}) {
  return new RequestError(400, { error: code, ...extra });
}

/**
 * @param {string} code
 * @param {Record<string, unknown>} [extra]
 */
export function conflict(code, extra = {}) {
  return new RequestError(409, { error: code, ...extra });
}

/**
 * @param {string} code
 * @param {Record<string, unknown>} [extra]
 */
export function unprocessable(code, extra = {}) {
  return new RequestError(422, { error: code, ...extra });
}
