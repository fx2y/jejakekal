/**
 * @typedef {{run_id: string, status: string, dbos_status?: string | null}} RunSeed
 */

/**
 * @param {unknown} body
 * @returns {RunSeed | null}
 */
export function runSeedFromStartResponse(body) {
  if (!body || typeof body !== 'object') return null;
  const row = /** @type {Record<string, unknown>} */ (body);
  const runId = row.run_id;
  if (typeof runId !== 'string' || runId.length === 0) return null;
  const statusValue = row.status;
  const status = typeof statusValue === 'string' && statusValue.length > 0 ? statusValue : 'running';
  const dbosStatusValue = row.dbos_status;
  const dbos_status = typeof dbosStatusValue === 'string' ? dbosStatusValue : null;
  return { run_id: runId, status, dbos_status };
}

/**
 * @param {{ok:boolean, body:unknown}} started
 * @param {(runId: string) => Promise<{ok:boolean, body:unknown}>} loadRun
 */
export async function resolveRunAfterStart(started, loadRun) {
  const seed = started.ok ? runSeedFromStartResponse(started.body) : null;
  if (!seed) return null;
  try {
    const runRes = await loadRun(seed.run_id);
    if (runRes.ok && runRes.body && typeof runRes.body === 'object') {
      return /** @type {import('./ui-view-model.mjs').RunProjection} */ (runRes.body);
    }
  } catch {
    // Fall back to durable start response when projection is not yet visible or transiently unavailable.
  }
  return seed;
}
