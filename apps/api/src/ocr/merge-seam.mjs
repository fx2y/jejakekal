import { computeOcrMergePlan } from './merge-core.mjs';

/**
 * @param {{
 *   docId?:string,
 *   version?:number,
 *   hardPages?:number[],
 *   currentBlocks?:unknown[],
 *   patches:Array<{page_idx:number,patch?:Record<string, unknown>}>
 * }} params
 */
export async function runOcrMergeSeam(params) {
  const fallbackMergedPages = (params.patches ?? [])
    .map((patch) => Number(patch.page_idx))
    .filter((page) => Number.isInteger(page) && page >= 0)
    .sort((a, b) => a - b);
  if (!params.docId || !Number.isInteger(params.version)) {
    return {
      merged_pages: fallbackMergedPages,
      replacement_blocks: [],
      page_diffs: [],
      diff_sha: null
    };
  }
  return computeOcrMergePlan({
    docId: params.docId,
    version: params.version,
    hardPages: params.hardPages ?? fallbackMergedPages,
    currentBlocks: params.currentBlocks ?? [],
    patches: params.patches ?? []
  });
}
