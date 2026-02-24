export const OCR_GATE_REV = 'c0-gate-stub-v1';

/**
 * @param {unknown} value
 */
function asRecord(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return /** @type {Record<string, unknown>} */ (value);
  }
  return {};
}

/**
 * @param {{markerJson?: unknown}} params
 */
export async function runOcrGateSeam(params) {
  const marker = asRecord(params.markerJson);
  const pages = Array.isArray(params.markerJson)
    ? params.markerJson
    : Array.isArray(marker.children)
      ? marker.children
      : [];
  return {
    gate_rev: OCR_GATE_REV,
    hard_pages: [],
    score_by_page: pages.map(() => 0),
    reasons: {}
  };
}
