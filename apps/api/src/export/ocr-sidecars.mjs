/**
 * @param {Array<number>} pages
 */
function formatPages(pages) {
  if (pages.length < 1) return 'none';
  return pages.join(',');
}

/**
 * @param {{source_job_id:string,diff_sha:string,rows:Array<{page_idx:number,before_sha:string,after_sha:string,changed_blocks:number,page_diff_sha:string}>}} input
 */
function buildDiffSummaryMarkdown(input) {
  const lines = ['# OCR diff summary', `- job_id: ${input.source_job_id}`, `- diff_sha: ${input.diff_sha}`];
  lines.push('## Pages');
  for (const row of input.rows) {
    lines.push(
      `- p${row.page_idx}: changed_blocks=${row.changed_blocks} page_diff_sha=${row.page_diff_sha} before=${row.before_sha} after=${row.after_sha}`
    );
  }
  return `${lines.join('\n').trim()}\n`;
}

/**
 * @param {string} runId
 */
function buildNoDiffSummaryMarkdown(runId) {
  return ['# OCR diff summary', `- job_id: ${runId}`, '- diff_sha: none', '## Pages', '- none'].join('\n') + '\n';
}

/**
 * @param {{source_job_id:string,hardPages:number[],ocrPages:number[],diffSha:string|null}} input
 */
function buildOcrReportMarkdown(input) {
  const lines = ['# OCR report', `- job_id: ${input.source_job_id}`];
  lines.push(`- hard_pages: ${formatPages(input.hardPages)}`);
  lines.push(`- ocr_pages: ${formatPages(input.ocrPages)}`);
  if (input.diffSha) {
    lines.push(`- diff_sha: ${input.diffSha}`);
  }
  return `${lines.join('\n').trim()}\n`;
}

/**
 * @param {import('pg').Client} client
 * @param {string} runId
 */
export async function buildOcrBundleSidecars(client, runId) {
  const ocrPagesRes = await client.query(
    `SELECT page_idx, status, gate_score, gate_reasons, png_uri, png_sha, raw_uri, raw_sha
     FROM ocr_page
     WHERE job_id = $1
     ORDER BY page_idx ASC`,
    [runId]
  );
  if (ocrPagesRes.rows.length < 1) return null;
  const pages = ocrPagesRes.rows.map((row) => ({
    page_idx: Number(row.page_idx),
    status: String(row.status),
    gate_score: row.gate_score == null ? null : Number(row.gate_score),
    gate_reasons: Array.isArray(row.gate_reasons) ? row.gate_reasons : [],
    png_uri: typeof row.png_uri === 'string' ? row.png_uri : null,
    png_sha: typeof row.png_sha === 'string' ? row.png_sha : null,
    raw_uri: typeof row.raw_uri === 'string' ? row.raw_uri : null,
    raw_sha: typeof row.raw_sha === 'string' ? row.raw_sha : null
  }));
  const diffRes = await client.query(
    `SELECT page_idx, before_sha, after_sha, changed_blocks, page_diff_sha, diff_sha
     FROM docir_page_diff
     WHERE source_job_id = $1
     ORDER BY page_idx ASC, created_at DESC`,
    [runId]
  );
  const diffRows = diffRes.rows.map((row) => ({
    page_idx: Number(row.page_idx),
    before_sha: String(row.before_sha),
    after_sha: String(row.after_sha),
    changed_blocks: Number(row.changed_blocks),
    page_diff_sha: String(row.page_diff_sha),
    diff_sha: String(row.diff_sha)
  }));
  const diffSha = diffRows[0]?.diff_sha ?? null;
  const hardPages = pages
    .filter((row) => ['gated', 'rendered', 'ocr_ready'].includes(row.status))
    .map((row) => row.page_idx);
  const ocrPages = pages.filter((row) => row.status === 'ocr_ready').map((row) => row.page_idx);
  return {
    ocr_pages: pages,
    ocr_report_md: buildOcrReportMarkdown({
      source_job_id: runId,
      hardPages,
      ocrPages,
      diffSha
    }),
    diff_summary_md: diffSha
      ? buildDiffSummaryMarkdown({
          source_job_id: runId,
          diff_sha: diffSha,
          rows: diffRows
        })
      : buildNoDiffSummaryMarkdown(runId),
    diff_sha: diffSha
  };
}
