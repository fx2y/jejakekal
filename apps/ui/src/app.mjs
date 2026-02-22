import { startRun } from './api-client.mjs';
import { renderArtifacts, renderTimeline, setRunStatus } from './render-execution.mjs';

const status = /** @type {HTMLElement|null} */ (document.getElementById('run-status'));
const timelineEl = /** @type {HTMLElement|null} */ (document.getElementById('timeline'));
const artifactsEl = /** @type {HTMLElement|null} */ (document.getElementById('artifacts'));
const inputEl = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('doc-input'));

function requireUiElements() {
  if (!status || !timelineEl || !artifactsEl || !inputEl) {
    throw new Error('ui-elements-missing');
  }
  return { status, timelineEl, artifactsEl, inputEl };
}

async function runWorkflow() {
  const ui = requireUiElements();

  setRunStatus(ui.status, 'running', 'running');
  const workflowId = `wf-${Date.now()}`;
  const result = await startRun({ workflowId, source: ui.inputEl.value });

  renderTimeline(ui.timelineEl, result.timeline);
  renderArtifacts(ui.artifactsEl, result.artifacts);
  setRunStatus(ui.status, 'done', `done:${workflowId}`);
}

document.getElementById('run-workflow')?.addEventListener('click', () => {
  runWorkflow().catch((error) => {
    if (status) {
      setRunStatus(status, 'error', String(error));
    }
  });
});
