const status = /** @type {HTMLElement|null} */ (document.getElementById('run-status'));
const timelineEl = /** @type {HTMLElement|null} */ (document.getElementById('timeline'));
const artifactsEl = /** @type {HTMLElement|null} */ (document.getElementById('artifacts'));
const inputEl = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('doc-input'));

async function runWorkflow() {
  if (!status || !timelineEl || !artifactsEl || !inputEl) {
    throw new Error('ui-elements-missing');
  }

  status.dataset.state = 'running';
  status.textContent = 'running';
  const workflowId = `wf-${Date.now()}`;

  const response = await fetch('/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workflowId, source: inputEl.value })
  });

  const result = await response.json();

  timelineEl.innerHTML = '';
  for (const row of result.timeline) {
    const li = document.createElement('li');
    li.textContent = `${row.step}:${row.phase}`;
    timelineEl.append(li);
  }

  artifactsEl.innerHTML = '';
  for (const artifact of result.artifacts) {
    const li = document.createElement('li');
    li.textContent = artifact.id;
    li.dataset.artifactId = artifact.id;
    artifactsEl.append(li);
  }

  status.dataset.state = 'done';
  status.textContent = `done:${workflowId}`;
}

document.getElementById('run-workflow')?.addEventListener('click', () => {
  runWorkflow().catch((error) => {
    if (status) {
      status.dataset.state = 'error';
      status.textContent = String(error);
    }
  });
});
