/**
 * @param {{query?:unknown}} params
 */
export function buildTableLanePlan(params) {
  return {
    lane: 'table',
    enabled: false,
    reason: 'lane_not_ready_c0',
    query: String(params.query ?? '').trim()
  };
}
