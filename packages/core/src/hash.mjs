import { createHash } from 'node:crypto';

/**
 * @param {string|Buffer} input
 */
export function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}
