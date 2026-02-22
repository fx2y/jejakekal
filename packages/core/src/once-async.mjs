/**
 * Wrap an async close/finalize function so successful completion is idempotent
 * while failures remain retryable.
 * @template {(...args: any[]) => Promise<void>} T
 * @param {T} fn
 * @returns {() => Promise<void>}
 */
export function onceAsync(fn) {
  let done = false;
  /** @type {Promise<void> | null} */
  let inFlight = null;

  return async () => {
    if (done) return;
    if (inFlight) {
      await inFlight;
      return;
    }
    inFlight = Promise.resolve()
      .then(() => fn())
      .then(() => {
        done = true;
      })
      .finally(() => {
        inFlight = null;
      });
    await inFlight;
  };
}
