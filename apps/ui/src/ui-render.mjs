import {
  artifactListItemModel,
  execRows,
  isRunResumable,
  markdownToHtml,
  renderPreJson,
  statusModel,
  uiEsc
} from './ui-view-model.mjs';
import { UI_ALIAS_IDS, UI_PLANE_IDS } from './contracts.mjs';

const EXEC_OOB_NEEDLE = `<aside id="${UI_ALIAS_IDS.execution}"`;
const EXEC_OOB_REPLACEMENT = `<aside id="${UI_ALIAS_IDS.execution}" hx-swap-oob="true"`;
const ARTIFACT_OOB_NEEDLE = `<main id="${UI_ALIAS_IDS.artifacts}"`;
const ARTIFACT_OOB_REPLACEMENT = `<main id="${UI_ALIAS_IDS.artifacts}" hx-swap-oob="true"`;

/**
 * @param {{type?: string, visibility?: string, q?: string, sleepMs?: number, step?: number}} filters
 */
function queryForFilters(filters) {
  const params = new URLSearchParams();
  if (filters.type) params.set('type', filters.type);
  if (filters.visibility) params.set('visibility', filters.visibility);
  if (filters.q) params.set('q', filters.q);
  if (typeof filters.sleepMs === 'number') params.set('sleepMs', String(filters.sleepMs));
  if (typeof filters.step === 'number') params.set('step', String(Math.max(0, Math.trunc(filters.step))));
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
  return `<section id="${UI_PLANE_IDS.conversation}" class="plane"><aside id="${UI_ALIAS_IDS.conversation}"><h1>Conversation</h1><form id="command-form" hx-post="/ui/commands" hx-target="#${UI_ALIAS_IDS.conversation}" hx-swap="outerHTML"><label for="cmd-input">Command</label><input id="cmd-input" name="cmd" type="text" value="/doc alpha beta gamma" required /><button type="submit">Run</button></form><p id="run-status" data-state="${uiEsc.escapeHtml(state)}">${uiEsc.escapeHtml(text)}</p></aside></section>`;
}

/**
 * @param {import('./ui-view-model.mjs').RunProjection | null} run
 * @param {{type?: string, visibility?: string, q?: string, sleepMs?: number, step?: number}} filters
 * @param {{status?: {state:string,text:string}, emptyText?: string}} [opts]
 */
export function renderExecutionPane(run, filters, opts = {}) {
  const status = opts.status ?? statusModel(run);
  const rows = execRows(run);
  const query = queryForFilters(filters);
  const pollAttrs =
    run && status.state === 'running'
      ? ` hx-get="/ui/runs/${encodeURIComponent(run.run_id)}/poll${query}" hx-trigger="every 1s" hx-swap="outerHTML"`
      : '';
  const items = rows
    .map(
      (row) => {
        const focused = typeof filters.step === 'number' && filters.step === row.function_id;
        const cost = row.cost == null ? 'n/a' : String(row.cost);
        return `<li data-function-id="${row.function_id}"${focused ? ' class="step-focus"' : ''}>${row.function_id}:${uiEsc.escapeHtml(row.function_name)}:${row.phase}:attempt=${row.attempt}:duration=${row.duration_ms == null ? 'n/a' : `${row.duration_ms}ms`}:io_hashes=${row.io_hash_count}:cost=${uiEsc.escapeHtml(cost)}</li>`;
      }
    )
    .join('');
  const resumeControl =
    run && isRunResumable(run)
      ? `<form id="resume-form" action="/ui/runs/${encodeURIComponent(run.run_id)}/resume${query}" method="post" hx-post="/ui/runs/${encodeURIComponent(run.run_id)}/resume${query}" hx-target="#${UI_ALIAS_IDS.execution}" hx-swap="outerHTML"><button type="submit">Resume</button></form>`
      : '';
  const body = run
    ? `<p><a href="/runs/${encodeURIComponent(run.run_id)}${query}" hx-push-url="true">open run</a></p>${resumeControl}<ul id="timeline">${items}</ul>`
    : `<p>${uiEsc.escapeHtml(opts.emptyText ?? 'No run selected.')}</p><ul id="timeline"></ul>`;
  return `<section id="${UI_PLANE_IDS.execution}" class="plane"><aside id="${UI_ALIAS_IDS.execution}"${pollAttrs}><h2>Execution</h2><p>status=${uiEsc.escapeHtml(status.state)}</p>${body}</aside></section>`;
}

/**
 * @param {string} execHtml
 */
export function withExecOob(execHtml) {
  return execHtml.replace(EXEC_OOB_NEEDLE, EXEC_OOB_REPLACEMENT);
}

/**
 * @param {Array<unknown>} artifacts
 * @param {{type?: string, visibility?: string, q?: string, step?: number}} filters
 * @param {{scope?: 'all'|'run', runId?: string}} [opts]
 */
export function renderArtifactsPane(artifacts, filters = {}, opts = {}) {
  const query = queryForFilters(filters);
  const scope = opts.scope ?? 'all';
  const scopeBanner =
    scope === 'run' && opts.runId
      ? `<p class="artifact-scope">scope=run:${uiEsc.escapeHtml(opts.runId)} <a href="/artifacts${query}" hx-push-url="true">show all</a></p>`
      : '';
  const items = artifacts
    .map((row) => artifactListItemModel(row))
    .map((artifact) => {
      const cost = artifact.cost == null ? 'n/a' : String(artifact.cost);
      const sourceCount = artifact.source_count == null ? 'n/a' : String(artifact.source_count);
      const title = artifact.title.length > 0 ? artifact.title : artifact.id;
      const stepSuffix =
        typeof artifact.producer_function_id === 'number' ? `?step=${artifact.producer_function_id}` : '';
      return `<li data-artifact-id="${uiEsc.escapeHtml(artifact.id)}"><a href="/artifacts/${encodeURIComponent(artifact.id)}${query}" hx-push-url="true">${uiEsc.escapeHtml(title)}</a><span> type=${uiEsc.escapeHtml(artifact.type)} run=<a href="/runs/${encodeURIComponent(artifact.run_id)}${stepSuffix}" hx-push-url="true">${uiEsc.escapeHtml(artifact.run_id)}</a> status=${uiEsc.escapeHtml(artifact.status)} time=${uiEsc.escapeHtml(prettyDate(artifact.created_at))} cost=${uiEsc.escapeHtml(cost)} source_count=${uiEsc.escapeHtml(sourceCount)}</span></li>`;
    })
    .join('');
  return `<section id="${UI_PLANE_IDS.artifact}" class="plane"><main id="${UI_ALIAS_IDS.artifacts}"><h2>Artifacts</h2>${scopeBanner}<form id="artifact-filters" hx-get="/artifacts" hx-target="#main" hx-push-url="true"><input name="type" placeholder="type" value="${uiEsc.escapeHtml(filters.type ?? '')}" /><input name="visibility" placeholder="visibility" value="${uiEsc.escapeHtml(filters.visibility ?? '')}" /><input name="q" placeholder="search title" value="${uiEsc.escapeHtml(filters.q ?? '')}" /><button type="submit">Filter</button></form><ul>${items}</ul></main></section>`;
}

/**
 * @param {{meta?: Record<string, unknown>|null, content?: unknown, prov?: unknown}|null} artifact
 */
export function renderArtifactViewer(artifact) {
  if (!artifact || !artifact.meta) {
    return `<section id="${UI_PLANE_IDS.artifact}" class="plane"><main id="${UI_ALIAS_IDS.artifacts}"><h2>Artifacts</h2><p>Artifact not found.</p></main></section>`;
  }
  const meta = artifact.meta;
  const runId = typeof meta.run_id === 'string' ? meta.run_id : '';
  const prov =
    artifact.prov && typeof artifact.prov === 'object' && !Array.isArray(artifact.prov)
      ? /** @type {Record<string, unknown>} */ (artifact.prov)
      : {};
  const producerFunctionId =
    typeof prov.producer_function_id === 'number' ? Math.trunc(prov.producer_function_id) : null;
  const runHref =
    producerFunctionId == null
      ? `/runs/${encodeURIComponent(runId)}`
      : `/runs/${encodeURIComponent(runId)}?step=${producerFunctionId}`;
  const format = typeof meta.format === 'string' ? meta.format : '';
  let contentHtml = renderPreJson(artifact.content ?? null);
  if (format === 'text/markdown') {
    contentHtml = `<article class="doc">${markdownToHtml(artifact.content)}</article>`;
  } else if (format.startsWith('text/')) {
    contentHtml = `<pre>${uiEsc.escapeHtml(String(artifact.content ?? ''))}</pre>`;
  }

  return `<section id="${UI_PLANE_IDS.artifact}" class="plane"><main id="${UI_ALIAS_IDS.artifacts}"><h2>Artifact ${uiEsc.escapeHtml(String(meta.id ?? ''))}</h2><p><a href="${runHref}" hx-push-url="true">open run</a> <a href="${runHref}" hx-push-url="true">open sources</a> <a href="/runs/${encodeURIComponent(runId)}/bundle.zip" hx-boost="false">Download run bundle</a></p>${contentHtml}<details><summary>provenance</summary>${renderPreJson(artifact.prov ?? {})}</details></main></section>`;
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
  return `${panes.exec}${panes.artifacts.replace(ARTIFACT_OOB_NEEDLE, ARTIFACT_OOB_REPLACEMENT)}<p id="run-status" data-state="${uiEsc.escapeHtml(panes.statusState)}" hx-swap-oob="true">${uiEsc.escapeHtml(panes.statusText)}</p>`;
}

/**
 * @param {{conv: string, exec: string, artifacts: string, statusText: string, statusState: string}} panes
 */
export function renderCommandFragment(panes) {
  return `${panes.conv}${withExecOob(panes.exec)}${panes.artifacts.replace(ARTIFACT_OOB_NEEDLE, ARTIFACT_OOB_REPLACEMENT)}<p id="run-status" data-state="${uiEsc.escapeHtml(panes.statusState)}" hx-swap-oob="true">${uiEsc.escapeHtml(panes.statusText)}</p>`;
}
