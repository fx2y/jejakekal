/**
 * @typedef {{
 *   run_id: string,
 *   status: string,
 *   dbos_status?: string | null,
 *   timeline?: Array<{function_id:number,function_name:string,error?:unknown,started_at_epoch_ms?:number|null,completed_at_epoch_ms?:number|null,duration_ms?:number|null,attempt?:number|null,io_hashes?:string[],cost?:number|null}>,
 *   artifacts?: Array<Record<string, unknown>>
 * }} RunProjection
 */

/**
 * @param {string | undefined} value
 */
function escapeHtml(value) {
  if (!value) return '';
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

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
 * @param {RunProjection | null | undefined} run
 */
export function statusModel(run) {
  if (!run) return { state: 'idle', text: 'idle' };
  if (run.status === 'running') return { state: 'running', text: `running:${run.run_id}` };
  if (run.status === 'done') return { state: 'done', text: `done:${run.run_id}` };
  if (run.status === 'error') {
    return { state: 'error', text: `error:${run.run_id}:${run.dbos_status ?? 'unknown'}` };
  }
  return { state: 'error', text: `error:${run.run_id}:unknown_status` };
}

/**
 * @param {RunProjection | null | undefined} run
 */
export function execRows(run) {
  if (!run) return [];
  return (run.timeline ?? []).map((row) => {
    const completed = typeof row.completed_at_epoch_ms === 'number' ? row.completed_at_epoch_ms : null;
    const started = typeof row.started_at_epoch_ms === 'number' ? row.started_at_epoch_ms : null;
    const durationMs =
      typeof row.duration_ms === 'number'
        ? row.duration_ms
        : completed != null && started != null
          ? Math.max(0, completed - started)
          : null;
    const attemptRaw = typeof row.attempt === 'number' ? row.attempt : Number(row.attempt ?? 1);
    const attempt = Number.isFinite(attemptRaw) ? Math.max(1, Math.trunc(attemptRaw)) : 1;
    const ioHashes = Array.isArray(row.io_hashes)
      ? row.io_hashes
          .filter((value) => typeof value === 'string')
          .map((value) => String(value))
      : [];
    return {
      function_id: row.function_id,
      function_name: row.function_name,
      phase: row.error ? 'error' : 'ok',
      duration_ms: durationMs,
      attempt,
      io_hash_count: ioHashes.length,
      cost: row.cost ?? null
    };
  });
}

/**
 * @param {RunProjection | null | undefined} run
 */
export function isRunResumable(run) {
  return !!run && ['CANCELLED', 'RETRIES_EXCEEDED'].includes(String(run.dbos_status ?? ''));
}

/**
 * @param {unknown} artifact
 */
export function artifactListItemModel(artifact) {
  const row = asRecord(artifact);
  const prov = asRecord(row['prov']);
  const sourceHashes = prov['source_hashes'];
  const hash = asRecord(prov['hash']);
  const sourceCount = Array.isArray(sourceHashes)
    ? sourceHashes.length
    : typeof hash['source_sha256'] === 'string' && String(hash['source_sha256']).length > 0
      ? 1
      : null;
  return {
    id: String(row['id'] ?? ''),
    run_id: String(row['run_id'] ?? ''),
    type: String(row['type'] ?? ''),
    title: typeof row['title'] === 'string' ? row['title'] : '',
    status: String(row['status'] ?? ''),
    visibility: String(row['visibility'] ?? ''),
    created_at: typeof row['created_at'] === 'string' ? row['created_at'] : '',
    cost: prov['cost'] ?? row['cost'] ?? null,
    source_count: sourceCount,
    producer_function_id:
      typeof prov['producer_function_id'] === 'number' ? Math.trunc(prov['producer_function_id']) : null
  };
}

/**
 * @param {unknown} value
 */
export function renderPreJson(value) {
  const safe = JSON.stringify(value ?? {}, null, 2);
  return `<pre>${escapeHtml(safe)}</pre>`;
}

/**
 * @param {unknown} markdown
 */
export function markdownToHtml(markdown) {
  const text = typeof markdown === 'string' ? markdown : String(markdown ?? '');
  const lines = text.split(/\r?\n/);
  const html = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('### ')) {
      html.push(`<h3>${escapeHtml(trimmed.slice(4))}</h3>`);
      continue;
    }
    if (trimmed.startsWith('## ')) {
      html.push(`<h2>${escapeHtml(trimmed.slice(3))}</h2>`);
      continue;
    }
    if (trimmed.startsWith('# ')) {
      html.push(`<h1>${escapeHtml(trimmed.slice(2))}</h1>`);
      continue;
    }
    html.push(`<p>${escapeHtml(trimmed)}</p>`);
  }
  return html.join('\n');
}

export const uiEsc = { escapeHtml };
