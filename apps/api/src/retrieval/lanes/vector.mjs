/**
 * @param {{query?:unknown}} params
 */
export function buildVectorLanePlan(params) {
  return {
    lane: 'vector',
    enabled: false,
    reason: 'lane_not_ready_c0',
    query: String(params.query ?? '').trim()
  };
}
