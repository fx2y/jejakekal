/**
 * @param {{pages:Array<{page_idx:number,png_uri:string|null,png_sha:string|null}>}} params
 */
export async function runOcrEngineSeam(params) {
  return {
    patches: (params.pages ?? []).map((page) => ({
      page_idx: page.page_idx,
      text_md: '',
      raw: null
    }))
  };
}
