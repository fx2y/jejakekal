import { artifactListItemModel, execRows, markdownToHtml, renderPreJson, statusModel, uiEsc } from './ui-view-model.mjs';

/**
 * @param {{type?: string, visibility?: string, q?: string, sleepMs?: number}} filters
 */
function queryForFilters(filters) {
  const params = new URLSearchParams();
  if (filters.type) params.set('type', filters.type);
  if (filters.visibility) params.set('visibility', filters.visibility);
  if (filters.q) params.set('q', filters.q);
  if (typeof filters.sleepMs === 'number') params.set('sleepMs', String(filters.sleepMs));
  const query = params.toString();
  return query.length > 0 ? `?${query}` : '';
}

/**
 * @param {string} value
 */
function prettyDate(value) {
  if (!value) return 'n/a';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

/**
 * @param {string} state
 * @param {string} text
 */
export function renderConversationPane(state, text) {
  return `<section id="conversation-plane" class="plane"><aside id="conv"><h1>Conversation</h1><form id="command-form" hx-post="/ui/commands" hx-target="#conv" hx-swap="outerHTML"><label for="cmd-input">Command</label><input id="cmd-input" name="cmd" type="text" value="/doc alpha beta gamma" required /><button type="submit">Run</button></form><p id="run-status" data-state="${uiEsc.escapeHtml(state)}">${uiEsc.escapeHtml(text)}</p></aside></section>`;
}

/**
 * @param {import('./ui-view-model.mjs').RunProjection | null} run
 * @param {{type?: string, visibility?: string, q?: string, sleepMs?: number}} filters
 */
export function renderExecutionPane(run, filters) {
  const status = statusModel(run);
  const rows = execRows(run);
  const query = queryForFilters(filters);
  const pollAttrs =
    run && status.state === 'running'
      ? ` hx-get="/ui/runs/${encodeURIComponent(run.run_id)}/poll${query}" hx-trigger="every 1s" hx-swap="outerHTML"`
      : '';
  const items = rows
    .map(
      (row) =>
        `<li data-function-id="${row.function_id}">${row.function_id}:${uiEsc.escapeHtml(row.function_name)}:${row.phase}${row.duration_ms == null ? '' : `:${row.duration_ms}ms`}</li>`
    )
    .join('');
  const body = run
    ? `<p><a href="/runs/${encodeURIComponent(run.run_id)}" hx-push-url="true">open run</a></p><ul id="timeline">${items}</ul>`
    : '<p>No run selected.</p><ul id="timeline"></ul>';
  return `<section id="execution-plane" class="plane"><aside id="exec"${pollAttrs}><h2>Execution</h2><p>status=${uiEsc.escapeHtml(status.state)}</p>${body}</aside></section>`;
}

/**
 * @param {Array<unknown>} artifacts
 * @param {{type?: string, visibility?: string, q?: string}} filters
 */
export function renderArtifactsPane(artifacts, filters = {}) {
  const query = queryForFilters(filters);
  const items = artifacts
    .map((row) => artifactListItemModel(row))
    .map((artifact) => {
      const cost = artifact.cost == null ? 'n/a' : String(artifact.cost);
      const sourceCount = artifact.source_count == null ? 'n/a' : String(artifact.source_count);
      const title = artifact.title.length > 0 ? artifact.title : artifact.id;
      return `<li data-artifact-id="${uiEsc.escapeHtml(artifact.id)}"><a href="/artifacts/${encodeURIComponent(artifact.id)}${query}" hx-push-url="true">${uiEsc.escapeHtml(title)}</a><span> type=${uiEsc.escapeHtml(artifact.type)} run=${uiEsc.escapeHtml(artifact.run_id)} status=${uiEsc.escapeHtml(artifact.status)} time=${uiEsc.escapeHtml(prettyDate(artifact.created_at))} cost=${uiEsc.escapeHtml(cost)} source_count=${uiEsc.escapeHtml(sourceCount)}</span></li>`;
    })
    .join('');
  return `<section id="artifact-plane" class="plane"><main id="artifacts"><h2>Artifacts</h2><form id="artifact-filters" hx-get="/artifacts" hx-target="#main" hx-push-url="true"><input name="type" placeholder="type" value="${uiEsc.escapeHtml(filters.type ?? '')}" /><input name="visibility" placeholder="visibility" value="${uiEsc.escapeHtml(filters.visibility ?? '')}" /><input name="q" placeholder="search title" value="${uiEsc.escapeHtml(filters.q ?? '')}" /><button type="submit">Filter</button></form><ul>${items}</ul></main></section>`;
}

/**
 * @param {{meta?: Record<string, unknown>|null, content?: unknown, prov?: unknown}|null} artifact
 */
export function renderArtifactViewer(artifact) {
  if (!artifact || !artifact.meta) {
    return '<section id="artifact-plane" class="plane"><main id="artifacts"><h2>Artifacts</h2><p>Artifact not found.</p></main></section>';
  }
  const meta = artifact.meta;
  const runId = typeof meta.run_id === 'string' ? meta.run_id : '';
  const format = typeof meta.format === 'string' ? meta.format : '';
  let contentHtml = renderPreJson(artifact.content ?? null);
  if (format === 'text/markdown') {
    contentHtml = `<article class="doc">${markdownToHtml(artifact.content)}</article>`;
  } else if (format.startsWith('text/')) {
    contentHtml = `<pre>${uiEsc.escapeHtml(String(artifact.content ?? ''))}</pre>`;
  }

  return `<section id="artifact-plane" class="plane"><main id="artifacts"><h2>Artifact ${uiEsc.escapeHtml(String(meta.id ?? ''))}</h2><p><a href="/runs/${encodeURIComponent(runId)}" hx-push-url="true">open run</a></p>${contentHtml}<details><summary>provenance</summary>${renderPreJson(artifact.prov ?? {})}</details></main></section>`;
}

/**
 * @param {{title?: string, conv: string, exec: string, artifacts: string}} panes
 */
export function renderPage(panes) {
  const title = panes.title ?? 'Jejakekal Harness';
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>${uiEsc.escapeHtml(title)}</title><link rel="stylesheet" href="/styles.css" /><script src="/htmx.min.js"></script><script>document.addEventListener('htmx:load',()=>{if(window.htmx){window.htmx.config.historyRestoreAsHxRequest=false;}});</script></head><body><main id="main" class="layout" hx-boost="true" hx-target="#main" hx-swap="outerHTML">${panes.conv}${panes.exec}${panes.artifacts}</main><script type="module" src="/app.js"></script></body></html>`;
}

/**
 * @param {{conv: string, exec: string, artifacts: string}} panes
 */
export function renderMainFragment(panes) {
  return `<main id="main" class="layout" hx-boost="true" hx-target="#main" hx-swap="outerHTML">${panes.conv}${panes.exec}${panes.artifacts}</main>`;
}

/**
 * @param {{exec: string, artifacts: string, statusText: string, statusState: string}} panes
 */
export function renderPollFragment(panes) {
  return `${panes.exec}${panes.artifacts.replace('<main id="artifacts"', '<main id="artifacts" hx-swap-oob="true"')}<p id="run-status" data-state="${uiEsc.escapeHtml(panes.statusState)}" hx-swap-oob="true">${uiEsc.escapeHtml(panes.statusText)}</p>`;
}

/**
 * @param {{conv: string, exec: string, artifacts: string, statusText: string, statusState: string}} panes
 */
export function renderCommandFragment(panes) {
  return `${panes.conv}${panes.exec.replace('<aside id="exec"', '<aside id="exec" hx-swap-oob="true"')}${panes.artifacts.replace('<main id="artifacts"', '<main id="artifacts" hx-swap-oob="true"')}<p id="run-status" data-state="${uiEsc.escapeHtml(panes.statusState)}" hx-swap-oob="true">${uiEsc.escapeHtml(panes.statusText)}</p>`;
}
