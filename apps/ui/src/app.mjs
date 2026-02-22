import { exportRun, pollRun, startRun } from './api-client.mjs';
import { renderArtifacts, renderTimeline, setRunStatus } from './render-execution.mjs';

const status = /** @type {HTMLElement|null} */ (document.getElementById('run-status'));
const timelineEl = /** @type {HTMLElement|null} */ (document.getElementById('timeline'));
const artifactsEl = /** @type {HTMLElement|null} */ (document.getElementById('artifacts'));
const inputEl = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('doc-input'));

function readOptionalSleepMsFromUrl() {
  const raw = new URL(window.location.href).searchParams.get('sleepMs');
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(1, Math.floor(parsed));
}

function requireUiElements() {
  if (!status || !timelineEl || !artifactsEl || !inputEl) {
    throw new Error('ui-elements-missing');
  }
  return { status, timelineEl, artifactsEl, inputEl };
}

async function runWorkflow() {
  const ui = requireUiElements();
  const sleepMs = readOptionalSleepMsFromUrl();

  setRunStatus(ui.status, 'running', 'running');
  const started = await startRun({ source: ui.inputEl.value, sleepMs });
  const run = await pollRun(started.run_id);
  if (run.status === 'unknown') {
    throw new Error(`run-unknown-status:${run.dbos_status ?? 'unknown'}`);
  }
  if (run.status !== 'done' && run.status !== 'error') {
    throw new Error(`run-timeout:${run.status}`);
  }
  const exported = await exportRun(started.run_id);

  renderTimeline(ui.timelineEl, run);
  renderArtifacts(ui.artifactsEl, exported.artifacts);
  setRunStatus(ui.status, run.status === 'error' ? 'error' : 'done', `${run.status}:${run.run_id}`);
}

document.getElementById('run-workflow')?.addEventListener('click', () => {
  runWorkflow().catch((error) => {
    if (status) {
      setRunStatus(status, 'error', String(error));
    }
  });
});
