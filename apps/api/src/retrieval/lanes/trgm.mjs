/**
 * @param {{query?:unknown}} params
 */
export function buildTrgmLanePlan(params) {
  return {
    lane: 'trgm',
    enabled: false,
    reason: 'lane_not_ready_c0',
    query: String(params.query ?? '').trim()
  };
}
