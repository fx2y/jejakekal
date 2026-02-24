/**
 * @param {{patches:Array<{page_idx:number}>}} params
 */
export async function runOcrMergeSeam(params) {
  return {
    merged_pages: (params.patches ?? []).map((patch) => patch.page_idx).sort((a, b) => a - b),
    diff_sha: null
  };
}
