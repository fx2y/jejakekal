import { runOcrGateSeam } from './gate-seam.mjs';
import { runOcrRenderSeam } from './render-seam.mjs';
import { runOcrEngineSeam } from './engine-seam.mjs';
import { runOcrMergeSeam } from './merge-seam.mjs';

/**
 * @param {{markerJson?:unknown}} input
 * @param {{
 *   gate?: (input:{markerJson?:unknown}) => Promise<{gate_rev:string,code_rev?:string,hard_pages:number[],score_by_page:number[],reasons:Record<string, string[]>}>,
 *   render?: (input:{hard_pages:number[],pdf_path?:string}) => Promise<{pages:Array<{page_idx:number,png:Buffer|null,png_sha:string|null,mime:string|null}>}>,
 *   ocr?: (input:{pages:Array<{page_idx:number,png:Buffer|null,png_sha:string|null,mime:string|null}>}) => Promise<{patches:Array<{page_idx:number,text_md:string,raw:unknown}>}>,
 *   merge?: (input:{patches:Array<{page_idx:number,text_md:string,raw:unknown}>}) => Promise<{merged_pages:number[],diff_sha:string|null}>
 * }} [seams]
 */
export async function runHardDocFallbackLane(input, seams = {}) {
  const gate = await (seams.gate ?? runOcrGateSeam)({ markerJson: input.markerJson });
  if (!Array.isArray(gate.hard_pages) || gate.hard_pages.length === 0) {
    return {
      gate,
      rendered_pages: [],
      ocr_pages: [],
      merge: { merged_pages: [], diff_sha: null }
    };
  }
  const rendered = await (seams.render ?? runOcrRenderSeam)({ hard_pages: gate.hard_pages });
  const ocr = await (seams.ocr ?? runOcrEngineSeam)({ pages: rendered.pages });
  const merge = await (seams.merge ?? runOcrMergeSeam)({ patches: ocr.patches });
  return {
    gate,
    rendered_pages: rendered.pages,
    ocr_pages: ocr.patches,
    merge
  };
}
