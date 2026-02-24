import { computeHardPages } from './gate-core.mjs';

/**
 * @param {{markerJson?: unknown, gateCfg?: unknown}} params
 */
export async function runOcrGateSeam(params) {
  return computeHardPages(params.markerJson, params.gateCfg);
}
