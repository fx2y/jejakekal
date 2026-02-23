/**
 * @param {string} value
 */
function oneLine(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

/**
 * @param {string | null | undefined} value
 */
function shortText(value) {
  const normalized = oneLine(value ?? '');
  if (normalized.length <= 200) return normalized;
  return `${normalized.slice(0, 197)}...`;
}

/**
 * @param {Array<{type:string}>} blocks
 */
function typeCounts(blocks) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const block of blocks) {
    const type = String(block.type);
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return Object.keys(counts)
    .sort()
    .map((type) => ({ type, count: counts[type] }));
}

/**
 * @param {Array<{block_id:string,page:number,text:string|null,data:Record<string, unknown>}>} blocks
 */
function excerptRows(blocks) {
  return blocks
    .map((block) => {
      const text = shortText(block.text);
      if (text.length > 0) {
        return { block_id: block.block_id, page: block.page, excerpt: text };
      }
      const title = typeof block.data?.title === 'string' ? shortText(block.data.title) : '';
      if (title.length > 0) {
        return { block_id: block.block_id, page: block.page, excerpt: title };
      }
      return null;
    })
    .filter(Boolean)
    .slice(0, 8);
}

/**
 * @param {{
 *  docId: string,
 *  version: number,
 *  rawSha: string,
 *  markerConfigSha?: string,
 *  blocks: Array<{block_id:string,type:string,page:number,text:string|null,data:Record<string, unknown>}>
 * }} params
 */
export function buildExecMemoMarkdown(params) {
  const lines = [`# Exec memo: ${params.docId} v${params.version}`, `- RawSHA: ${params.rawSha}`];
  if (typeof params.markerConfigSha === 'string' && params.markerConfigSha.length > 0) {
    lines.push(`- MarkerCfgSHA: ${params.markerConfigSha}`);
  }
  lines.push(`- BlockCount: ${params.blocks.length}`);

  lines.push('## Block counts');
  for (const row of typeCounts(params.blocks)) {
    lines.push(`- ${row.type}: ${row.count}`);
  }

  lines.push('## Key excerpts (block refs)');
  for (const row of excerptRows(params.blocks)) {
    lines.push(`- [b:${row.block_id}] (p${row.page}) ${row.excerpt}`);
  }

  return `${lines.join('\n').trim()}\n`;
}
