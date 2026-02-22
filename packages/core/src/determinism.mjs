/**
 * @param {{now?: number, random?: number}} opts
 */
export function freezeDeterminism(opts = {}) {
  const now = opts.now ?? Date.parse('2026-01-01T00:00:00.000Z');
  const random = opts.random ?? 0.123456789;
  const originalNow = Date.now;
  const originalRandom = Math.random;

  Date.now = () => now;
  Math.random = () => random;

  return () => {
    Date.now = originalNow;
    Math.random = originalRandom;
  };
}
