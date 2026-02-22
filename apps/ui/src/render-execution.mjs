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
 * @param {Array<{step: string, phase: string}>} timeline
 */
export function renderTimeline(timelineEl, timeline) {
  timelineEl.innerHTML = '';
  for (const row of timeline) {
    const li = document.createElement('li');
    li.textContent = `${row.step}:${row.phase}`;
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
