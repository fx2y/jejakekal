import { parseToDocIR, routeNeedsOCR } from '../docir.mjs';

/**
 * @param {{source: string}} opts
 */
export function runDocirParser(opts) {
  const doc = parseToDocIR(opts.source);
  return {
    doc,
    ocrRequired: routeNeedsOCR(doc)
  };
}
