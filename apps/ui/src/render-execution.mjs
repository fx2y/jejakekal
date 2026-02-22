/**
 * @param {HTMLElement} statusEl
 * @param {'idle'|'running'|'done'|'error'} state
 * @param {string} text
 */
export function setRunStatus(statusEl, state, text) {
  statusEl.dataset.state = state;
  statusEl.textContent = text;
}

/**
 * @param {HTMLElement} timelineEl
 * @param {{
 * run_id: string,
 * status: string,
 * dbos_status?: string | null,
 * header?: {
 *   name?: string | null,
 *   created_at?: string | number | null,
 *   updated_at?: string | number | null,
 *   recovery_attempts?: number | null,
 *   executor_id?: string | null
 * },
 * timeline?: Array<{
 *   function_id: number,
 *   function_name: string,
 *   started_at_epoch_ms?: number | null,
 *   completed_at_epoch_ms?: number | null,
 *   output?: unknown,
 *   error?: unknown
 * }>
 * }} run
 */
export function renderTimeline(timelineEl, run) {
  timelineEl.innerHTML = '';

  const summary = document.createElement('li');
  summary.textContent = `run_id=${run.run_id} name=${run.header?.name ?? ''} status=${run.status}/${run.dbos_status ?? 'unknown'}`;
  timelineEl.append(summary);

  const meta = document.createElement('li');
  meta.textContent = `created=${run.header?.created_at ?? 'n/a'} updated=${run.header?.updated_at ?? 'n/a'} recovery_attempts=${run.header?.recovery_attempts ?? 'n/a'} executor_id=${run.header?.executor_id ?? 'n/a'}`;
  timelineEl.append(meta);

  for (const row of run.timeline ?? []) {
    const li = document.createElement('li');
    const phase = row.error ? 'error' : 'ok';
    li.textContent = `${row.function_id}:${row.function_name}:${phase}`;
    li.dataset.functionId = String(row.function_id);
    timelineEl.append(li);
  }
}

/**
 * @param {HTMLElement} artifactsEl
 * @param {Array<{id: string}>} artifacts
 */
export function renderArtifacts(artifactsEl, artifacts) {
  artifactsEl.innerHTML = '';
  for (const artifact of artifacts) {
    const li = document.createElement('li');
    li.textContent = artifact.id;
    li.dataset.artifactId = artifact.id;
    artifactsEl.append(li);
  }
}
